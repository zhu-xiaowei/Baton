// v2 App ⇄ Bridge direct channel over one `app_data` socket. Callers only use
// request(device, method, params); credentials, whoami, routing, resend, retry and timeout
// are handled here by a single reconcile() pass that runs on every event.
import { state } from '../state.js';
import { createHeaderSigner } from '../../../bridge/terminal-direct-protocol.mjs';
import { RpcAssembler, decodeRpcPayload, rpcRequest } from '../../../bridge/direct-rpc-protocol.mjs';

const RETRY_MS = 2000;
const DEADLINE_MS = 6000;
const PING_MS = 60000;
const PROBE_MS = 1000;
const CAN_INFLATE = typeof DecompressionStream === 'function' && (() => {
  try { new DecompressionStream('deflate-raw'); return true; } catch { return false; }
})();

const routes = new Map();     // device → { online, dataId, version }
let rpc = null;               // { endpoint, region, credentials }
let socket = null;
let connectionId = '';
let dataUrl = '';
let retryTimer = null;
let pingTimer = null;
let tickTimer = null;
let lastInboundAt = 0;
let probeTimer = null;
const pending = new Map();    // key → request state
const byRequestId = new Map(); // wire requestId → key
const assembler = new RpcAssembler();
let routesKnown = false;      // true once /devices answered in this page
let devicesInflight = null;

function storageKey() {
  return 'baton-v2-rpc:' + state.SERVER;
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Cached routes let the first request go out before /devices answers.
let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey()) || 'null');
    if (saved) applyRpc(saved.rpc, { persist: false });
  } catch {}
}

// Routes not in `bridges` are offline (a device without a route counts as offline too).
function applyRpc(next, { persist = true } = {}) {
  if (!next) return;
  // The region is part of the execute-api host: <api>.execute-api.<region>.amazonaws.com.
  rpc = { endpoint: next.endpoint, region: new URL(next.endpoint).host.split('.')[2], credentials: next.credentials };
  const seen = new Set();
  for (const bridge of next.bridges || []) {
    seen.add(bridge.device);
    const version = bridge.dataId + '|' + (next.credentials?.sessionToken || '').slice(-16);
    const previous = routes.get(bridge.device);
    if (previous?.version !== version || !previous.online) {
      routes.set(bridge.device, { online: true, dataId: bridge.dataId, version });
    }
  }
  for (const [device, route] of routes) {
    if (!seen.has(device)) routes.set(device, { ...route, online: false, version: route.version + '|off' });
  }
  if (persist) {
    try { localStorage.setItem(storageKey(), JSON.stringify({ rpc: next })); } catch {}
  }
  reconcile();
}

// Called with the /devices response; every route difference is resent by reconcile().
export function updateRoutes(devicesResponse) {
  restore();
  routesKnown = true;
  if (devicesResponse?.rpc) applyRpc(devicesResponse.rpc);
  else reconcile();
}

export function cachedOnlineDevices() {
  restore();
  return [...routes].filter(([, route]) => route.online).map(([device]) => device);
}

// A socket idle past the ping interval may have been dropped by a NAT without a close event:
// ping it and rebuild it if nothing arrives within a second. whoami then resends pending requests.
function probe() {
  const ws = socket;
  if (!ws || ws.readyState !== WebSocket.OPEN || probeTimer || performance.now() - lastInboundAt < PING_MS) return;
  const sentAt = performance.now();
  ws.send('{"action":"realtime_ping"}');
  probeTimer = setTimeout(() => {
    probeTimer = null;
    if (socket !== ws || lastInboundAt >= sentAt) return;
    ws.onclose = null;
    ws.close();
    socket = null;
    connectionId = '';
    clearInterval(pingTimer);
    connect();
  }, PROBE_MS);
}

if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') probe(); });
}

// The server is reached through its CloudFront domain, which also serves /data.
export function connect() {
  if (!state.KEY || !state.SERVER) return;
  dataUrl ||= 'wss://' + new URL(state.SERVER).host + '/data';
  if (socket?.readyState === WebSocket.OPEN) return probe();
  if (socket?.readyState === WebSocket.CONNECTING) return;
  const started = performance.now();
  const ws = socket = new WebSocket(dataUrl + '?' + new URLSearchParams({ apiKey: state.KEY, role: 'app_data' }));
  connectionId = '';
  ws.onopen = () => {
    if (socket !== ws) return;
    timing('connect', performance.now() - started);
    const whoamiAt = performance.now();
    ws.__whoamiAt = whoamiAt;
    ws.send(JSON.stringify({ action: 'whoami' }));
    // Without an id nothing can be addressed to this socket; rebuild it rather than wait for a drop.
    setTimeout(() => { if (socket === ws && !connectionId) ws.close(); }, 5000);
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && ws.readyState === WebSocket.OPEN) ws.send('{"action":"realtime_ping"}');
    }, PING_MS);
  };
  ws.onmessage = (event) => { lastInboundAt = performance.now(); receive(ws, event.data); };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    connectionId = '';
    clearInterval(pingTimer);
    if (!retryTimer) retryTimer = setTimeout(() => { retryTimer = null; connect(); }, 1000 + Math.random() * 2000);
  };
}

function receive(ws, text) {
  let frame;
  try { frame = JSON.parse(text); } catch { return; }
  if (frame.action === 'whoami' && frame.connectionId) {
    connectionId = frame.connectionId;
    timing('whoami', performance.now() - ws.__whoamiAt);
    for (const request of pending.values()) request.attemptVersion = null;
    reconcile();
    return;
  }
  if (frame.action === 'direct_rpc' && frame.type === 'bridges') {
    applyRpc(frame.rpc);
    return;
  }
  const part = assembler.add(frame);
  if (!part?.done) return;
  const key = byRequestId.get(part.requestId);
  const request = key && pending.get(key);
  if (!request) return;
  finish(key, request, part.error ? { error: part.error } : { payload: part.payload });
}

async function finish(key, request, outcome) {
  pending.delete(key);
  for (const id of request.ids) { byRequestId.delete(id); assembler.forget(id); }
  timing('rtt:' + request.device, performance.now() - request.sentAt);
  if (outcome.error) return request.reject(new Error(outcome.error));
  if (!outcome.payload) return request.reject(new Error(outcome.reason || 'failed'));
  try { request.resolve(await decodeRpcPayload(outcome.payload, inflate)); }
  catch (error) { request.reject(error); }
}

async function send(key, request, route) {
  const requestId = uuid();
  request.ids.add(requestId);
  byRequestId.set(requestId, key);
  request.attemptVersion = route.version;
  request.sentAt = performance.now();
  request.firstSentAt ??= request.sentAt;
  const body = rpcRequest({ requestId, method: request.method, params: request.params, replyTo: connectionId });
  if (!CAN_INFLATE) body.accept = [];
  try {
    const sign = createHeaderSigner({ endpoint: rpc.endpoint, region: rpc.region, credentials: rpc.credentials,
      target: route.dataId, action: 'terminal_direct_data' });
    socket.send(await sign(JSON.stringify(body)));
  } catch {
    request.attemptVersion = null;
  }
}

function reconcile() {
  const now = performance.now();
  for (const [key, request] of pending) {
    const route = routes.get(request.device);
    if (routesKnown && (!route || !route.online)) { finish(key, request, { reason: 'offline' }); continue; }
    if (request.firstSentAt && now - request.firstSentAt > DEADLINE_MS) { finish(key, request, { reason: 'timeout' }); continue; }
    if (now - request.createdAt > DEADLINE_MS * 2) { finish(key, request, { reason: 'timeout' }); continue; }
    if (!route?.online || !connectionId || !rpc?.credentials || socket?.readyState !== WebSocket.OPEN) continue;
    const stale = request.attemptVersion !== route.version;
    const retry = !stale && !request.retried && now - request.sentAt > RETRY_MS;
    if (retry) request.retried = true;
    if (stale || retry) send(key, request, route);
  }
  if (pending.size && !tickTimer) {
    tickTimer = setInterval(() => { if (!pending.size) { clearInterval(tickTimer); tickTimer = null; } reconcile(); }, 250);
  }
}

// GET /devices; its routes reach pending requests at once. Concurrent callers share one request.
export function devices() {
  devicesInflight ||= (async () => {
    const response = await fetch(state.SERVER + '/api/bridge/devices', { headers: { 'x-api-key': state.KEY } });
    if (response.status === 401 || response.status === 403) window.logout?.();
    if (!response.ok) throw new Error(response.status + ' ' + response.statusText);
    const body = await response.json();
    if (body.protocol === 2) updateRoutes(body);
    return body;
  })().finally(() => { devicesInflight = null; });
  return devicesInflight;
}

export function request(device, method, params = {}) {
  restore();
  connect();
  // A page opened without the home (reload, link) still learns current routes and credentials.
  if (!routesKnown && !devicesInflight) devices().catch(() => {});
  const key = uuid();
  return new Promise((resolve, reject) => {
    pending.set(key, { device, method, params, resolve, reject, ids: new Set(), createdAt: performance.now(),
      attemptVersion: null, retried: false, sentAt: 0, firstSentAt: null });
    reconcile();
  });
}

export function resetDirectTransport() {
  routes.clear();
  rpc = null;
  routesKnown = false;
  restored = true;
  dataUrl = '';
  try { localStorage.removeItem(storageKey()); } catch {}
  if (socket) { const ws = socket; socket = null; ws.close(); }
}

function timing(name, ms) {
  const timings = (window.__v2Timings ||= {});
  timings[name] = Math.round(ms);
}
