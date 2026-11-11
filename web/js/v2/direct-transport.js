// v2 App ⇄ Bridge direct channel over one `app_data` socket. Callers use
// request(device, method, params, { onSlow, ack, onAccepted }), subscribe()/unsubscribe() and
// onPush(); credentials, whoami, routing, resend, retry, timeout and resubscription are handled
// here, requests by a single reconcile() pass that runs on every event.
// One requestId per request: the Bridge answers a resend from its stored reply, never twice.
import { state } from '../state.js';
import { createHeaderSigner } from '../../../bridge/terminal-direct-protocol.mjs';
import { RpcAssembler, decodeRpcPayload, rpcRequest, rpcRequestFrames } from '../../../bridge/direct-rpc-protocol.mjs';

// At SLOW_MS the page is told (it shows its cache) and the request is resent once: all of it if no
// chunk arrived, else only the missing chunks. At DEADLINE_MS it fails.
const SLOW_MS = 6000;
const DEADLINE_MS = 12000;
const LATE_RESEND_MS = 2000; // a first send later than SLOW_MS - this (cold start) is resent this soon after it
const PING_MS = 60000;
const PROBE_MS = 1000;
// A request this long without any inbound frame pings the socket (rebuilt after the same wait
// without an answer); a request that asked for a receipt and has none is sent again.
const STALL_MS = 3000;
const ACKED_DEADLINE_MS = 60000; // after a receipt or progress, the next sign of life may take this long
const RENEW_MS = 5 * 60000;      // credentials with less than this left are renewed before signing
const PING = '{"action":"realtime_ping"}';
// After a drop: reconnect at once, then up to this many retries 0–2 s apart. Later requests,
// foregrounding or a route update connect again.
const MAX_RETRIES = 3;
const RETRY_JITTER_MS = 2000;
const CAN_INFLATE = typeof DecompressionStream === 'function' && (() => {
  try { new DecompressionStream('deflate-raw'); return true; } catch { return false; }
})();
const CAN_DEFLATE = typeof CompressionStream === 'function' && (() => {
  try { new CompressionStream('deflate-raw'); return true; } catch { return false; }
})();

const routes = new Map();     // device → { online, dataId, version }
let rpc = null;               // { endpoint, region, credentials }
let socket = null;
let connectionId = '';
let lastId = '';                // the latest connection id, kept across a drop
let dataUrl = '';
let retryTimer = null;
let retries = 0;              // consecutive drops since the last whoami
let pingTimer = null;
let tickTimer = null;
let lastInboundAt = 0;
let probeTimer = null;
const pending = new Map();    // requestId → request state
const assembler = new RpcAssembler();
const pushes = new RpcAssembler(64);
let pushQueue = Promise.resolve(); // pushes are decoded and delivered in arrival order
const pushListeners = new Set();
const resyncListeners = new Set();
const subscriptions = new Map(); // `device|sessionId` → { device, sessionId, inflight }
const epochs = new Map();        // device → the Bridge process its last subscribe reply came from
const pongWaiters = [];
let replacedId = '';           // this App's previous connection, which the Bridge may still push to
let devicesAt = 0;
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

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
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
  if (!persist) return;
  for (const device of cameOnline) {
    for (const listener of onlineListeners) listener(device);
    resubscribe(device);
  }
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

// Session events pushed by a Bridge this App subscribed to.
export function onPush(listener) {
  pushListeners.add(listener);
}

// Pushes may have been missed (reconnect, a Bridge that restarted): the page reloads what it shows.
export function onResync(listener) {
  resyncListeners.add(listener);
}

function resync(device) {
  for (const listener of resyncListeners) listener(device);
}

// The Bridge keeps a subscription for 150 s; it is renewed on every ping tick and made again
// after a reconnect, when the device returns and when the page is shown again. `root` is the thread
// root the page shows. `quiet`: the history request about to go out subscribes (`subscribed()`
// reports it); only without that reply is a subscribe sent.
export function subscribe(device, sessionId, { root = '', quiet = false } = {}) {
  const key = device + '|' + sessionId;
  let entry = subscriptions.get(key);
  if (!entry) subscriptions.set(key, entry = { device, sessionId, root, inflight: false, fallback: null });
  if (root) entry.root = root;
  clearTimeout(entry.fallback);
  entry.fallback = null;
  if (quiet) entry.fallback = setTimeout(() => { entry.fallback = null; sendSubscribe(entry, false); }, STALL_MS);
  else sendSubscribe(entry, false);
}

export function subscribed(device, sessionId, epoch) {
  const entry = subscriptions.get(device + '|' + sessionId);
  if (!entry) return;
  clearTimeout(entry.fallback);
  entry.fallback = null;
  noteEpoch(device, epoch);
}

export function unsubscribe(device, sessionId) {
  const entry = subscriptions.get(device + '|' + sessionId);
  if (!entry) return;
  clearTimeout(entry.fallback);
  subscriptions.delete(device + '|' + sessionId);
  leave(device, sessionId);
}

function noteEpoch(device, epoch) {
  const known = epochs.get(device);
  epochs.set(device, epoch);
  if (known && known !== epoch) resync(device);
}

function leave(device, sessionId) {
  if (connectionId && routes.get(device)?.online) request(device, 'unsubscribe', { sessionId }).catch(() => {});
}

function sendSubscribe(entry, renew) {
  if (entry.inflight || document.visibilityState !== 'visible') return;
  entry.inflight = true;
  const params = { sessionId: entry.sessionId, ...(entry.root ? { rootSessionId: entry.root } : {}),
    ...(renew ? { renew: true } : replacedId ? { replaces: replacedId } : {}) };
  request(entry.device, 'subscribe', params).then((reply) => noteEpoch(entry.device, reply.epoch), () => {})
    .finally(() => { entry.inflight = false; });
}

// Entries waiting on a history request (`quiet`) are left to it; its fallback covers a failure.
function resubscribe(device) {
  for (const entry of subscriptions.values()) if ((!device || entry.device === device) && !entry.fallback) sendSubscribe(entry, false);
}

// Resolves at the socket's next pong: everything posted to it before has arrived by then.
export function ping() {
  return new Promise((resolve) => {
    // One ping in flight answers every waiter.
    if (pongWaiters.push(resolve) === 1 && socket?.readyState === WebSocket.OPEN) socket.send(PING);
  });
}

// A socket idle past the ping interval may have been dropped by a NAT without a close event:
// ping it and rebuild it if nothing arrives within a second. whoami then resends pending requests.
// `stalled`: a request is waiting on a silent socket, so ping now and allow a slow network.
function probe(stalled) {
  const ws = socket;
  if (!ws || ws.readyState !== WebSocket.OPEN || probeTimer || (!stalled && performance.now() - lastInboundAt < PING_MS)) return;
  const sentAt = performance.now();
  ws.send(PING);
  probeTimer = setTimeout(() => {
    probeTimer = null;
    if (socket !== ws || lastInboundAt >= sentAt) return;
    ws.onclose = null;
    ws.close();
    socket = null;
    connectionId = '';
    clearInterval(pingTimer);
    connect();
  }, stalled ? STALL_MS : PROBE_MS);
}

// A hidden page leaves its Sessions at once so the Bridge stops pushing; shown again it rejoins.
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      for (const entry of subscriptions.values()) leave(entry.device, entry.sessionId);
      return;
    }
    if (subscriptions.size) connect();
    else probe();
    resubscribe();
  });
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
    // One keepalive while visible: the subscription renewal (an end-to-end check through the
    // Bridge) when a Session is open, otherwise the gateway ping.
    pingTimer = setInterval(() => {
      if (document.visibilityState !== 'visible' || ws.readyState !== WebSocket.OPEN) return;
      let renewed = false;
      for (const entry of subscriptions.values()) {
        if (!routes.get(entry.device)?.online) continue;
        sendSubscribe(entry, true);
        renewed = true;
      }
      if (!renewed) ws.send(PING);
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
    // A hidden page reconnects only for a request in flight; showing it reconnects. Past the
    // quick retries, keep trying only while a visible page still needs the socket.
    const visible = document.visibilityState === 'visible';
    const needed = visible && (pending.size || subscriptions.size);
    if (retryTimer || (!visible && !pending.size) || (retries > MAX_RETRIES && !needed)) return;
    const delay = !retries++ ? 0 : Math.random() * RETRY_JITTER_MS + (retries > MAX_RETRIES ? 5000 : 0);
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
  };
}

function receive(ws, text) {
  let frame;
  try { frame = JSON.parse(text); } catch { return; }
  if (frame.action === 'whoami' && frame.connectionId) {
    const reconnected = !!lastId;
    replacedId = lastId;
    connectionId = lastId = frame.connectionId;
    retries = 0;
    timing('whoami', performance.now() - ws.__whoamiAt);
    for (const request of pending.values()) request.attemptVersion = null;
    reconcile();
    resubscribe();
    if (reconnected) resync();
    if (pongWaiters.length) ws.send(PING); // the ping they wait for went down with the old socket
    return;
  }
  if (frame.action === 'realtime_pong') {
    for (const done of pongWaiters.splice(0)) done();
    return;
  }
  if (frame.kind === 'push') {
    const part = pushes.add(frame);
    if (part?.payload) {
      pushQueue = pushQueue.then(() => decodeRpcPayload(part.payload, inflate))
        .then((event) => { for (const listener of pushListeners) listener(event); }).catch(() => {});
    }
    return;
  }
  if (frame.kind === 'rpc_ack' || frame.kind === 'rpc_progress') {
    const request = pending.get(frame.requestId);
    if (!request) return;
    request.aliveAt = performance.now();
    if (!request.acked) {
      request.acked = true;
      try { request.onAccepted?.(); } catch {}
    }
    if (frame.kind === 'rpc_progress' && frame.progress !== undefined) {
      try { request.onProgress?.(frame.progress); } catch {}
    }
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
  const body = rpcRequest({ requestId: key, method: request.method, params: request.params, replyTo: connectionId, missing,
    ack: request.ack });
  if (!CAN_INFLATE) body.accept = [];
  try {
    // One signer per route (a route is replaced when its Bridge or the credentials change).
    route.sign ||= createHeaderSigner({ endpoint: rpc.endpoint, region: rpc.region, credentials: rpc.credentials,
      target: route.dataId, action: 'rpc' });
    request.frames ||= await rpcRequestFrames(body, CAN_DEFLATE ? deflate : null);
    const frames = request.frames.map((frame) => ({ ...frame, replyTo: connectionId, ...(missing?.length ? { missing } : {}) }));
    for (const frame of frames) socket.send(await route.sign(JSON.stringify(frame), undefined, { method: request.method }));
  } catch (error) {
    request.attemptVersion = null;
    // Too large even in chunks: fail now instead of signing it again until the deadline.
    if (/exceeds/.test(error?.message || '')) finish(key, request, { reason: 'too_large' });
  }
}

function reconcile() {
  const now = performance.now();
  for (const [key, request] of pending) {
    const route = routes.get(request.device);
    if (routesKnown && (!route || !route.online)) { finish(key, request, { reason: 'offline' }); continue; }
    if (request.acked ? now - request.aliveAt > ACKED_DEADLINE_MS : now - request.createdAt > DEADLINE_MS) { finish(key, request, { reason: 'timeout' }); continue; }
    if (!request.slow && now - request.createdAt > SLOW_MS) {
      request.slow = true;
      try { request.onSlow?.(); } catch {}
    }
    if (!route?.online || !connectionId || !rpc?.credentials || socket?.readyState !== WebSocket.OPEN) continue;
    // Credentials are renewed on demand, right before signing; expired ones wait for the new ones.
    const left = rpc.credentials.expiresAt * 1000 - Date.now();
    if (left < RENEW_MS && !devicesInflight && now - devicesAt > STALL_MS) devices().catch(() => {});
    if (left < 5000) continue;
    const stalled = request.attemptVersion === route.version && now - request.sentAt > STALL_MS;
    if (stalled && lastInboundAt < request.sentAt) probe(true);
    // A new route or connection needs the whole reply again; a stall only what is missing.
    if (request.attemptVersion !== route.version) send(key, request, route);
    else if (request.ack && !request.acked) { if (stalled) send(key, request, route); }
    else if (!request.retried && now - request.firstSentAt
      > (request.firstSentAt - request.createdAt > SLOW_MS - LATE_RESEND_MS ? LATE_RESEND_MS : SLOW_MS)) {
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
  devicesAt = performance.now();
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

// `ack` asks the Bridge for a receipt on arrival: `onAccepted` runs once. After a receipt or a
// progress frame (a long request, `onProgress(value)` when it carries one) the request may take
// ACKED_DEADLINE_MS more from the latest of them.
export function request(device, method, params = {}, { onSlow, ack, onAccepted, onProgress } = {}) {
  restore();
  connect();
  // A page opened without the home (reload, link) still learns current routes and credentials.
  if (!routesKnown && !devicesInflight) devices().catch(() => {});
  const key = uuid();
  return new Promise((resolve, reject) => {
    pending.set(key, { device, method, params, resolve, reject, onSlow, ack: !!ack, onAccepted, onProgress, acked: false, aliveAt: 0, createdAt: performance.now(),
      attemptVersion: null, retried: false, slow: false, sentAt: 0, firstSentAt: null });
    reconcile();
  });
}

export function resetDirectTransport() {
  routes.clear();
  subscriptions.clear();
  epochs.clear();
  lastId = replacedId = '';
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
