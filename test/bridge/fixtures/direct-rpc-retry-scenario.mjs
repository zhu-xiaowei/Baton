// One retry scenario per worker thread (each has its own globals): the App transport, loaded as is,
// against a real DirectRpcBridge through an in-process relay that injects faults.
import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { DirectRpcBridge } from '../../../bridge/direct-rpc.mjs';
import { state } from '../../../web/js/state.js';

const ENDPOINT = 'https://data.execute-api.ap-northeast-1.amazonaws.com/v1';
const credentials = () => ({ accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'TOKEN', expiresAt: Math.floor(Date.now() / 1000) + 3600 });
const store = new Map();
Object.assign(globalThis, {
  window: globalThis,
  localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
  document: { visibilityState: 'visible', addEventListener() {} },
});
state.KEY = 'key';
state.SERVER = 'https://baton.example';

// One relay per scenario: the App socket, the Bridge, and the faults to apply.
function scenario({ devicesDelayMs = 0, online = true, dropRequests = 0, dropChunks = [], silent = false, computeMs = 0, result = { ok: 1 },
  deadSockets = [], appExpiresIn = 3600, bridgeExpiresIn = 3600 } = {}) {
  const log = { requests: 0, computed: 0, chunksSent: 0, slowAt: null, fetches: 0, credentialRequests: 0, subscribes: [] };
  let epoch = 'a';
  let appSocket = null;
  let connections = 0;
  const bridgeSocket = {
    readyState: 1,
    send(text) { // signed reply → the App connection named in it
      const { target, body } = JSON.parse(text);
      log.chunksSent++;
      const frame = JSON.parse(body);
      if (silent) return;
      if (frame.chunk && dropChunks.includes(frame.chunk.index)) { dropChunks = dropChunks.filter((i) => i !== frame.chunk.index); return; }
      if (appSocket?.id === target && appSocket.readyState === 1) setTimeout(() => appSocket.onmessage?.({ data: body }), 5);
    },
  };
  const bridge = new DirectRpcBridge({ key: 'key', handlers: {
    work: async (params) => { log.computed++; await new Promise((r) => setTimeout(r, computeMs)); return params.text ? { length: params.text.length } : result; },
    subscribe: (params, caller) => {
      log.subscribes.push({ to: caller.replyTo, renew: !!params.renew });
      if (params.replaces) bridge.subscribers.remove(params.sessionId, params.replaces);
      bridge.subscribers.add(params.sessionId, caller.replyTo, caller.deflate);
      return { epoch };
    },
    unsubscribe: (params, caller) => { bridge.subscribers.remove(params.sessionId, caller.replyTo); return {}; },
  }, sendControl: (message) => { // the server answers a credentials request on the control socket
    if (message.op !== 'credentials') return true;
    log.credentialRequests++;
    setTimeout(() => bridge.handleControl({ action: 'direct_rpc', type: 'credentials', endpoint: ENDPOINT,
      region: 'ap-northeast-1', credentials: credentials() }), 20);
    return true;
  } });
  bridge.auth = { endpoint: ENDPOINT, region: 'ap-northeast-1',
    credentials: { ...credentials(), expiresAt: Math.floor(Date.now() / 1000) + bridgeExpiresIn } };
  bridge.socket = bridgeSocket;
  class FakeWebSocket {
    static OPEN = 1; static CONNECTING = 0;
    constructor() {
      this.readyState = 0;
      this.id = `app${++connections}=`;
      this.dead = deadSockets.includes(connections); // open, but nothing passes after whoami
      appSocket = this;
      setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 5);
    }
    send(text) {
      if (text.includes('"action":"whoami"')) return setTimeout(() => this.onmessage?.({ data: JSON.stringify({ action: 'whoami', connectionId: this.id }) }), 5);
      if (this.dead) return;
      if (text.includes('realtime_ping')) return setTimeout(() => this.onmessage?.({ data: '{"action":"realtime_pong"}' }), 5);
      const { body } = JSON.parse(text);
      log.requests++;
      if (dropRequests > 0) { dropRequests--; return; }
      setTimeout(() => bridge.receive(bridgeSocket, body), 5);
    }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  globalThis.WebSocket = FakeWebSocket;
  // The first /devices reply carries credentials with `appExpiresIn` left, later ones fresh credentials.
  globalThis.fetch = async () => (await new Promise((r) => setTimeout(r, devicesDelayMs)), { ok: true, status: 200, json: async () => ({ protocol: 2, devices: [],
    rpc: { endpoint: ENDPOINT, bridges: online ? [{ device: 'dev', dataId: 'bridge=' }] : [],
      credentials: { ...credentials(), sessionToken: 'TOKEN' + log.fetches, expiresAt: Math.floor(Date.now() / 1000) + (log.fetches++ ? 3600 : appExpiresIn) } } }) });
  return { log, bridge, reconnect: () => appSocket.close(), restart: () => { epoch = 'b'; } };
}

async function run(options) {
  const env = scenario(options);
  const transport = await import('../../../web/js/v2/direct-transport.js');
  if (!options.coldStart) await transport.devices(); // a cold start learns routes from the request itself
  const started = performance.now();
  if (options.push) return pushScenario(env, transport);
  const promise = transport.request('dev', 'work', options.text ? { text: options.text } : {}, { ack: options.ack,
    onSlow: () => { env.log.slowAt = performance.now() - started; },
    onAccepted: () => { env.log.acceptedAt = performance.now() - started; } });
  if (options.reconnectAt) setTimeout(env.reconnect, options.reconnectAt);
  let outcome;
  try { outcome = { value: await promise }; } catch (error) { outcome = { error: error.message }; }
  return { ...outcome, ...env.log, ms: performance.now() - started };
}

// Subscribe, receive pushes, reconnect, meet a restarted Bridge, leave.
async function pushScenario(env, transport) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const pushes = [];
  const resyncs = [];
  transport.onPush((event) => pushes.push(event));
  transport.onResync((device) => resyncs.push(device || 'all'));
  const big = { sessionId: 's1', action: 'stream_end', seq: 2, text: Array.from({ length: 1500 }, (_, i) => createHash('sha256').update(String(i)).digest('hex')) };
  env.bridge.publish({ sessionId: 's1', action: 'stream_delta', seq: 0 }); // nobody subscribed: nothing is sent
  const unsubscribed = env.log.chunksSent;
  transport.subscribe('dev', 's1');
  await wait(100);
  env.bridge.publish({ sessionId: 's1', action: 'stream_delta', seq: 1, chunk: 'hi' });
  env.bridge.publish(big);
  env.bridge.publish({ sessionId: 'other', action: 'stream_delta', seq: 0 });
  await wait(150);
  const first = pushes.splice(0);
  env.restart();
  env.reconnect();
  await wait(200);
  env.bridge.publish({ sessionId: 's1', action: 'stream_delta', seq: 3 });
  await wait(100);
  const afterReconnect = pushes.splice(0);
  transport.unsubscribe('dev', 's1');
  await wait(100);
  const before = env.log.chunksSent;
  env.bridge.publish({ sessionId: 's1', action: 'stream_delta', seq: 4 });
  await wait(50);
  return { unsubscribed, first, bigIntact: JSON.stringify(first[1]) === JSON.stringify(big), afterReconnect, resyncs,
    subscribes: env.log.subscribes, sentAfterLeave: env.log.chunksSent - before };
}

const options = { ...workerData };
if (options.big) options.result = { items: Array.from({ length: 1500 }, (_, i) => createHash('sha256').update(String(i)).digest('hex')) };
parentPort.postMessage(await run(options));
