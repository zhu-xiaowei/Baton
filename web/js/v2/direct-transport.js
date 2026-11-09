// v2 App ⇄ Bridge direct channel over one `app_data` socket. Callers only use
// request(device, method, params, { onSlow }); credentials, whoami, routing, resend, retry and
// timeout are handled here by a single reconcile() pass that runs on every event.
// One requestId per request: the Bridge answers a resend from its stored reply, never twice.
import { state } from '../state.js';
import { createHeaderSigner } from '../../../bridge/terminal-direct-protocol.mjs';
import { RpcAssembler, decodeRpcPayload, rpcRequest } from '../../../bridge/direct-rpc-protocol.mjs';

// At SLOW_MS the page is told (it shows its cache) and the request is resent once: all of it if no
// chunk arrived, else only the missing chunks. At DEADLINE_MS it fails.
const SLOW_MS = 6000;
const DEADLINE_MS = 12000;
const PING_MS = 60000;
const PROBE_MS = 1000;
// After a drop: reconnect at once, then up to this many retries 0–2 s apart. Later requests,
// foregrounding or a route update connect again.
const MAX_RETRIES = 3;
const RETRY_JITTER_MS = 2000;
const CAN_INFLATE = typeof DecompressionStream === 'function' && (() => {
  try { new DecompressionStream('deflate-raw'); return true; } catch { return false; }
})();

const routes = new Map();     // device → { online, dataId, version }
let rpc = null;               // { endpoint, region, credentials }
let socket = null;
let connectionId = '';
let dataUrl = '';
let retryTimer = null;
let retries = 0;              // consecutive drops since the last whoami
let pingTimer = null;
let tickTimer = null;
let lastInboundAt = 0;
let probeTimer = null;
const pending = new Map();    // requestId → request state
const assembler = new RpcAssembler();
let routesKnown = false;      // true once /devices answered since the socket last dropped
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
  const cameOnline = [];
  for (const bridge of next.bridges || []) {
    seen.add(bridge.device);
    const version = bridge.dataId + '|' + (next.credentials?.sessionToken || '').slice(-16);
    const previous = routes.get(bridge.device);
    if (previous?.version !== version || !previous.online) {
      routes.set(bridge.device, { online: true, dataId: bridge.dataId, version });
    }
    if (!previous?.online) cameOnline.push(bridge.device);
  }
  for (const [device, route] of routes) {
    if (!seen.has(device)) routes.set(device, { ...route, online: false, version: route.version + '|off' });
  }
  if (persist) {
    try { localStorage.setItem(storageKey(), JSON.stringify({ rpc: next })); } catch {}
  }
  reconcile();
  if (persist) for (const device of cameOnline) for (const listener of onlineListeners) listener(device);
}

// Pages learn when a device's Bridge joins (or rejoins) and can be asked again.
const onlineListeners = new Set();
export function onDeviceOnline(listener) {
  onlineListeners.add(listener);
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
    // bridges_changed pushes are missed while closed, so the next request fetches /devices again.
    routesKnown = false;
    if (retryTimer || retries > MAX_RETRIES) return;
    const delay = retries++ ? Math.random() * RETRY_JITTER_MS : 0;
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
  };
}

function receive(ws, text) {
  let frame;
  try { frame = JSON.parse(text); } catch { return; }
  if (frame.action === 'whoami' && frame.connectionId) {
    connectionId = frame.connectionId;
    retries = 0;
    timing('whoami', performance.now() - ws.__whoamiAt);
    for (const request of pending.values()) request.attemptVersion = null;
    reconcile();
    return;
  }
  if (frame.action === 'direct_rpc' && frame.type === 'bridges') {
    applyRpc(frame.rpc);
    return;
  }
  if (!pending.has(frame.requestId)) return;
  const part = assembler.add(frame);
  if (!part?.done) return;
  finish(part.requestId, pending.get(part.requestId), part.error ? { error: part.error } : { payload: part.payload });
}

async function finish(key, request, outcome) {
  pending.delete(key);
  assembler.forget(key);
  timing('rtt:' + request.device, performance.now() - request.sentAt);
  if (outcome.error) return request.reject(new Error(outcome.error));
  if (!outcome.payload) return request.reject(new Error(outcome.reason || 'failed'));
  try { request.resolve(await decodeRpcPayload(outcome.payload, inflate)); }
  catch (error) { request.reject(error); }
}

async function send(key, request, route, missing) {
  request.attemptVersion = route.version;
  request.sentAt = performance.now();
  request.firstSentAt ??= request.sentAt;
  const body = rpcRequest({ requestId: key, method: request.method, params: request.params, replyTo: connectionId, missing });
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
    if (now - request.createdAt > DEADLINE_MS) { finish(key, request, { reason: 'timeout' }); continue; }
    if (!request.slow && now - request.createdAt > SLOW_MS) {
      request.slow = true;
      try { request.onSlow?.(); } catch {}
    }
    if (!route?.online || !connectionId || !rpc?.credentials || socket?.readyState !== WebSocket.OPEN) continue;
    // A new route or connection needs the whole reply again; a stall only what is missing.
    if (request.attemptVersion !== route.version) send(key, request, route);
    else if (!request.retried && now - request.firstSentAt > SLOW_MS) {
      request.retried = true;
      send(key, request, route, assembler.missing(key) || undefined);
    }
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

export function request(device, method, params = {}, { onSlow } = {}) {
  restore();
  connect();
  // A page opened without the home (reload, link) still learns current routes and credentials.
  if (!routesKnown && !devicesInflight) devices().catch(() => {});
  const key = uuid();
  return new Promise((resolve, reject) => {
    pending.set(key, { device, method, params, resolve, reject, onSlow, createdAt: performance.now(),
      attemptVersion: null, retried: false, slow: false, sentAt: 0, firstSentAt: null });
    reconcile();
  });
}

export function resetDirectTransport() {
  routes.clear();
  rpc = null;
  routesKnown = false;
  restored = true;
  dataUrl = '';
  clearTimeout(retryTimer);
  retryTimer = null;
  retries = 0;
  try { localStorage.removeItem(storageKey()); } catch {}
  if (socket) { const ws = socket; socket = null; ws.close(); }
}

function timing(name, ms) {
  const timings = (window.__v2Timings ||= {});
  timings[name] = Math.round(ms);
}
