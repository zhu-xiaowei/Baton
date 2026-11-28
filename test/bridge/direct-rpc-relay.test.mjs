// Relay transport (Cloudflare): the App transport and a DirectRpcBridge on one socket each, unsigned `{ to }` frames.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const store = new Map();
Object.assign(globalThis, { window: globalThis, document: { visibilityState: 'visible', addEventListener() {} },
  localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) } });
const { state } = await import('../../web/js/state.js');
const { saveAccountKey } = await import('../../web/js/v2/account-key.js');
const { DirectRpcBridge } = await import('../../bridge/direct-rpc.mjs');
Object.assign(state, { KEY: 'key', SERVER: 'https://baton.example' });

test('relay: the Bridge joins on its control socket, frames go unsigned both ways, peer_left drops subscribers', async () => {
  const control = [], toApp = [], toBridge = [];
  let app;
  const accountKey = randomBytes(32);
  await saveAccountKey(state.SERVER, accountKey);
  const bridge = new DirectRpcBridge({ key: 'key', accountKey, sendControl: (m) => (control.push(m), true),
    handlers: { work: (params, caller) => (bridge.subscribers.add('s1', caller.replyTo), { ok: 1 }) },
    controlSocket: { readyState: 1, bufferedAmount: 0, send: (text) => { toApp.push(JSON.parse(text)); setTimeout(() => app.onmessage({ data: text })); } } });
  bridge.start();
  bridge.handleControl({ action: 'direct_rpc', type: 'credentials', transport: 'relay', maxFrameBytes: 1048576, credentials: null, storage: null });
  bridge.handleControl({ action: 'direct_rpc', type: 'joined', id: 'b1' });
  assert.deepEqual(control.map((m) => m.op), ['credentials', 'bridge_join']);
  globalThis.WebSocket = class { static OPEN = 1; static CONNECTING = 0;
    constructor(url) { app = this; this.url = url; this.readyState = 1; setTimeout(() => this.onopen()); }
    send(text) {
      const frame = JSON.parse(text);
      if (frame.action === 'whoami') return setTimeout(() => this.onmessage({ data: '{"action":"whoami","connectionId":"a1"}' }));
      toBridge.push(frame);
      bridge.receiveFrame(frame, text.length);
    }
    close() { this.onclose?.({ code: 1000 }); } };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ protocol: 2, devices: [], rpc: { transport: 'relay',
    url: 'wss://relay.example/ws', maxFrameBytes: 1048576, credentials: null, storage: null,
    bridges: [{ device: 'dev', dataId: 'b1', pub: bridge.keys.pub, fp: bridge.keys.fp }] } }) });
  const transport = await import('../../web/js/v2/direct-transport.js');
  await transport.devices();
  assert.deepEqual(await transport.request('dev', 'work'), { ok: 1 });
  assert.equal(app.url, 'wss://relay.example/ws?apiKey=key&role=app&hello=1');
  assert.ok(toBridge.length && toBridge.every((f) => f.to === 'b1' && f.kind === 'rpc'));
  assert.ok(toApp.length && toApp.every((f) => f.to === 'a1' && f.kind === 'rpc_result'));
  assert.equal(bridge.subscribers.targets('s1').length, 1);
  bridge.handleControl({ action: 'peer_left', id: 'a1' });
  assert.equal(bridge.subscribers.targets('s1').length, 0);
  bridge.dispose();
  document.visibilityState = 'hidden'; // a hidden page does not reconnect
  app.close();
});

test('relay sizes: preview chunks and acks follow maxFrameBytes; R2 URLs are path-style on its endpoint', async () => {
  const { previewSizes } = await import('../../bridge/preview-protocol.mjs');
  const { presign } = await import('../../bridge/transfer-store.mjs');
  assert.deepEqual([previewSizes(0), previewSizes(1048576)], [{ chunk: 16384, ack: 65536 }, { chunk: 262144, ack: 1048576 }]);
  const url = new URL(await presign({ bucket: 'b', region: 'auto', accountId: 'acc', endpoint: 'https://cf.r2.cloudflarestorage.com',
    credentials: { accessKeyId: 'AK', secretAccessKey: 'SK', expiresAt: Math.floor(Date.now() / 1000) + 600 } }, 'GET', 'a'.repeat(32)));
  assert.equal(url.host + url.pathname, 'cf.r2.cloudflarestorage.com/b/t/acc/' + 'a'.repeat(32));
  assert.match(url.searchParams.get('X-Amz-Credential'), /\/auto\/s3\/aws4_request$/);
});
