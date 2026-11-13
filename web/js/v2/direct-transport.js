// v2 App ⇄ Bridge direct channel over one `app_data` socket. Callers use
// request(device, method, params, { onSlow, ack, onAccepted }), subscribe()/unsubscribe(),
// onPush() and openStream() (terminal, preview); credentials, whoami, routing, resend, retry,
// timeout and resubscription are handled here, requests by a single reconcile() pass that runs on
// every event.
// One requestId per request: the Bridge answers a resend from its stored reply, never twice.
import { state } from '../state.js';
import { RpcAssembler, createHeaderSigner, decodeRpcPayload, fromBase64, openStreamMessage, packStreamMessage, rpcRequest,
  rpcRequestFrames, sealStreamMessage, streamFrame, toBase64, unpackStreamMessage } from '../../../bridge/direct-rpc-protocol.mjs';
import { appKeys } from '../../../bridge/e2ee.mjs';
import { loadAccountKey, saveAccountKey } from './account-key.js';
import { setTransferAccess, setTransferKeys } from '../../../bridge/transfer-store.mjs';

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
const streams = new Map();       // `ch|id` → { device, ch, id, onMessage, chain }
let replacedId = '';           // this App's previous connection, which the Bridge may still push to
let devicesAt = 0;
let routesKnown = false;      // true once /devices answered since the socket last dropped
let devicesInflight = null;
let keys = null;              // appKeys(K): every frame but `account_key` is sealed (e2ee.mjs)
let keysLoaded = null;
let migrating = null;
let migratedAt = -Infinity;
let handedK = null;           // K this page created or took: handed over again, never replaced by a new one

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
  rpc = { endpoint: next.endpoint, region: new URL(next.endpoint).host.split('.')[2], credentials: next.credentials,
    storage: next.storage || null };
  const seen = new Set();
  const cameOnline = [];
  const rekeyed = [];
  for (const bridge of next.bridges || []) {
    seen.add(bridge.device);
    const version = bridge.dataId + '|' + (bridge.pub || '').slice(-8) + '|' + (next.credentials?.sessionToken || '').slice(-16);
    const previous = routes.get(bridge.device);
    if (previous?.version !== version || !previous.online) {
      routes.set(bridge.device, { online: true, dataId: bridge.dataId, version, pub: bridge.pub || '', fp: bridge.fp || '' });
    }
    if (!previous?.online) cameOnline.push(bridge.device);
    else if (previous.pub !== (bridge.pub || '')) rekeyed.push(bridge.device); // a new session: subscribe again
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
  for (const device of rekeyed) resubscribe(device);
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
// `foreground`: the page was shown, after which a socket often only looks open (iOS suspends it);
// ping at once while requests go out as usual, allowing a slow network as for a stalled request.
function probe({ stalled = false, foreground = false } = {}) {
  const ws = socket;
  if (!ws || ws.readyState !== WebSocket.OPEN || probeTimer
    || (!stalled && !foreground && performance.now() - lastInboundAt < PING_MS)) return;
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
  }, stalled || foreground ? STALL_MS : PROBE_MS);
}

// A hidden page leaves its Sessions at once so the Bridge stops pushing; shown again it rejoins.
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      for (const entry of subscriptions.values()) leave(entry.device, entry.sessionId);
      return;
    }
    if (socket?.readyState === WebSocket.OPEN) probe({ foreground: true });
    else if (subscriptions.size) connect();
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
  if (frame.kind === 'stream') {
    const entry = streams.get(frame.ch + '|' + frame.id);
    if (!entry || !frame.m) return;
    entry.inbound = entry.inbound.then(async () => {
      const session = await sessionFor(entry.device);
      const m = session && await openStreamMessage(frame, frame.m, session.open);
      if (m) entry.onMessage(await unpackStreamMessage(m, inflate));
    }).catch(() => {});
    return;
  }
  if (frame.kind === 'push') {
    const part = pushes.add(frame);
    if (part?.payload) {
      pushQueue = pushQueue.then(() => decodeRpcPayload(part.payload, inflate, openAny))
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
    if (frame.kind === 'rpc_progress' && frame.data && request.session) {
      decodeRpcPayload({ enc: frame.enc, data: frame.data, head: frame }, inflate, request.session.open)
        .then((progress) => request.onProgress?.(progress)).catch(() => {});
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
  // A clear error is the Bridge's own before any session (`too_large`) or an `account_key` failure; others are dropped.
  if (part.error && part.error !== 'too_large' && pending.get(part.requestId).method !== 'account_key') return;
  finish(part.requestId, pending.get(part.requestId), part.error ? { error: part.error } : { payload: part.payload, failed: part.failed });
}

// Pushes do not say which Bridge sealed them; each live session is tried (a wrong key fails at once).
async function openAny(head, text) {
  for (const route of routes.values()) {
    const session = route.online && await routeSession(route);
    const out = session && await session.open(head, text);
    if (out) return out;
  }
  return null;
}

// An alert the phone could not open before showing it (bridge/notify.mjs `e`).
export async function openAlert(event) {
  await accountKeys();
  return keys && event?.e ? keys.openAlert(event) : event;
}

// For the notification code on the phone (iOS extension, Android service): K's alert key only.
export async function notifyKey() {
  await accountKeys();
  return keys ? keys.notifyKey() : '';
}

function accountKeys() {
  keysLoaded ||= loadAccountKey(state.SERVER).then(async (saved) => { if (saved?.key && !keys) keys = await appKeys(saved.key, saved.at); });
  return keysLoaded;
}

function routeSession(route) {
  return keys && route?.pub && route.fp === keys.fp ? keys.session(route.pub) : null;
}

async function sessionFor(device) {
  await accountKeys();
  return routeSession(routes.get(device));
}

// Existing users have only the API key: the App takes K from a Bridge that has one (the smallest
// fingerprint wins, so every App and Bridge converge), or creates it, and gives it to the Bridges
// without it, which then join again with sealed sessions (docs/v2-accounts-e2ee-plan.md §9).
function migrate() {
  if (migrating || performance.now() - migratedAt < STALL_MS) return;
  migrating = (async () => {
    const online = [...routes].filter(([, route]) => route.online);
    const keyed = online.filter(([, route]) => route.fp).sort(([, a], [, b]) => (a.fp < b.fp ? -1 : 1));
    const take = async (fp) => (await request(keyed.find(([, route]) => route.fp === fp)[0], 'account_key', {})).k;
    // Routes still without a fingerprint after a handover (a late update) get the same K again.
    let raw = null;
    if (!keyed.length) raw = handedK || crypto.getRandomValues(new Uint8Array(32));
    else if (keys?.fp !== keyed[0][1].fp) raw = fromBase64(await take(keyed[0][1].fp));
    if (raw?.length === 32 && raw !== handedK) {
      handedK = raw;
      const saved = await saveAccountKey(state.SERVER, raw);
      keys = await appKeys(saved.key, saved.at);
      window.dispatchEvent?.(new Event('baton-account-key'));
    }
    if (!keys) return;
    const missing = online.filter(([, route]) => route.fp !== keys.fp);
    if (!missing.length) return;
    const k = raw ? toBase64(raw) : await take(keys.fp);
    await Promise.all(missing.map(([device]) => request(device, 'account_key', { k })));
  })().catch(() => {}).finally(() => { migrating = null; migratedAt = performance.now(); });
}

async function finish(key, request, outcome) {
  pending.delete(key);
  assembler.forget(key);
  timing('rtt:' + request.device, performance.now() - request.sentAt);
  if (outcome.error) return request.reject(new Error(outcome.error));
  if (!outcome.payload) return request.reject(new Error(outcome.reason || 'failed'));
  try {
    const value = await decodeRpcPayload(outcome.payload, inflate, request.method === 'account_key' ? null : request.session?.open);
    if (outcome.failed) request.reject(new Error(value.error));
    else request.resolve(value);
  } catch (error) { request.reject(error); }
}

async function send(key, request, route, missing) {
  request.attemptVersion = route.version;
  request.sentAt = performance.now();
  request.firstSentAt ??= request.sentAt;
  const body = rpcRequest({ requestId: key, method: request.method, params: request.params, replyTo: connectionId, missing,
    ack: request.ack });
  if (!CAN_INFLATE) body.accept = [];
  try {
    const clear = request.method === 'account_key';
    const session = clear ? null : await sessionFor(request.device);
    if (!clear && !session) {
      request.attemptVersion = null;
      return migrate();
    }
    // Sealed once per session: a resend carries the same chunks, so they assemble on the Bridge.
    if (session && request.session !== session) {
      request.session = session;
      body.pk = keys.pub;
      request.frames = await rpcRequestFrames(body, CAN_DEFLATE ? deflate : null, session.seal);
    }
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
    if (stalled && lastInboundAt < request.sentAt) probe({ stalled: true });
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

// The account's S3 transfer area with the current credentials, renewed when little time is left.
export async function storageAccess() {
  restore();
  const left = rpc?.credentials ? rpc.credentials.expiresAt * 1000 - Date.now() : 0;
  if (!rpc?.storage || left < RENEW_MS) await devices();
  if (!rpc?.storage || !rpc.credentials) throw new Error('File storage is unavailable');
  return { ...rpc.storage, credentials: rpc.credentials };
}

setTransferAccess(storageAccess);
setTransferKeys(() => accountKeys().then(() => keys?.files() || null));

// A terminal or preview stream to `device` on this socket: `send(message)` in order, `onMessage`
// for what the Bridge sends to `id`. Messages are best effort; both channels resend and resync.
export function openStream(device, ch, id, onMessage) {
  restore();
  connect();
  if (!routesKnown && !devicesInflight) devices().catch(() => {});
  const key = ch + '|' + id;
  const entry = { device, ch, id, onMessage, chain: Promise.resolve(), inbound: Promise.resolve(), pkFor: '' };
  streams.set(key, entry);
  return {
    send(message) {
      entry.chain = entry.chain.then(() => sendStream(entry, message)).catch(() => {});
    },
    get bufferedAmount() { return socket?.bufferedAmount || 0; },
    close() { if (streams.get(key) === entry) streams.delete(key); },
  };
}

const STREAM_WAIT_MS = 5000;

async function sendStream(entry, message) {
  // A page opened before the socket or its routes are known waits for them briefly.
  for (const started = performance.now(); ; await new Promise((resolve) => setTimeout(resolve, 100))) {
    const route = routes.get(entry.device);
    const left = rpc?.credentials ? rpc.credentials.expiresAt * 1000 - Date.now() : 0;
    if (route?.online && connectionId && socket?.readyState === WebSocket.OPEN && left > 5000) break;
    if (left < RENEW_MS && !devicesInflight && performance.now() - devicesAt > STALL_MS) devices().catch(() => {});
    if (performance.now() - started > STREAM_WAIT_MS) return;
  }
  const route = routes.get(entry.device);
  route.sign ||= createHeaderSigner({ endpoint: rpc.endpoint, region: rpc.region, credentials: rpc.credentials,
    target: route.dataId, action: 'rpc' });
  const session = await sessionFor(entry.device);
  if (!session) return migrate();
  const m = await sealStreamMessage({ kind: 'stream', ch: entry.ch, id: entry.id },
    await packStreamMessage(message, CAN_DEFLATE ? deflate : null), session.seal);
  // `inflate`: the Bridge may send this page deflated data.
  // The Bridge decides compression once per channel, when it opens (`open` / `start`).
  const opens = message.type === 'open' || message.type === 'start';
  // The public key goes with the first frame to each Bridge process, then only its tag.
  const pk = entry.pkFor !== route.pub ? { pk: keys.pub } : {};
  entry.pkFor = route.pub;
  const frame = { ...streamFrame(entry.ch, entry.id, connectionId, m), s: keys.tag, ...pk, ...(CAN_INFLATE && opens ? { inflate: 1 } : {}) };
  socket.send(await route.sign(JSON.stringify(frame), undefined, { stream: entry.ch }));
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
  keys = keysLoaded = handedK = null;
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
