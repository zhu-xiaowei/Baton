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
function scenario({ online = true, dropRequests = 0, dropChunks = [], silent = false, computeMs = 0, result = { ok: 1 } } = {}) {
  const log = { requests: 0, computed: 0, chunksSent: 0, slowAt: null };
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
  const bridge = new DirectRpcBridge({ key: 'key', sendControl: () => true, handlers: {
    work: async () => { log.computed++; await new Promise((r) => setTimeout(r, computeMs)); return result; },
  } });
  bridge.auth = { endpoint: ENDPOINT, region: 'ap-northeast-1', credentials: credentials() };
  bridge.socket = bridgeSocket;
  class FakeWebSocket {
    static OPEN = 1; static CONNECTING = 0;
    constructor() {
      this.readyState = 0;
      this.id = `app${++connections}=`;
      appSocket = this;
      setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 5);
    }
    send(text) {
      if (text.includes('"action":"whoami"')) return setTimeout(() => this.onmessage?.({ data: JSON.stringify({ action: 'whoami', connectionId: this.id }) }), 5);
      if (text.includes('realtime_ping')) return;
      const { body } = JSON.parse(text);
      log.requests++;
      if (dropRequests > 0) { dropRequests--; return; }
      setTimeout(() => bridge.receive(bridgeSocket, body), 5);
    }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  globalThis.WebSocket = FakeWebSocket;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ protocol: 2, devices: [],
    rpc: { endpoint: ENDPOINT, credentials: credentials(), bridges: online ? [{ device: 'dev', dataId: 'bridge=' }] : [] } }) });
  return { log, bridge, reconnect: () => appSocket.close() };
}

async function run(options) {
  const env = scenario(options);
  const transport = await import('../../../web/js/v2/direct-transport.js');
  await transport.devices();
  const started = performance.now();
  const promise = transport.request('dev', 'work', {}, { onSlow: () => { env.log.slowAt = performance.now() - started; } });
  if (options.reconnectAt) setTimeout(env.reconnect, options.reconnectAt);
  let outcome;
  try { outcome = { value: await promise }; } catch (error) { outcome = { error: error.message }; }
  return { ...outcome, ...env.log, ms: performance.now() - started };
}

const options = { ...workerData };
if (options.big) options.result = { items: Array.from({ length: 1500 }, (_, i) => createHash('sha256').update(String(i)).digest('hex')) };
parentPort.postMessage(await run(options));
