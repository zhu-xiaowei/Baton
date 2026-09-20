import assert from 'node:assert/strict';
import test from 'node:test';
import { RealtimeSender } from '../../bridge/realtime-direct.mjs';
import { RealtimeReceiver, realtimePayload } from '../../bridge/realtime-direct-protocol.mjs';
import { authenticateFrame, verifyFrame } from '../../bridge/terminal-direct-protocol.mjs';
import { TurnEventQueue } from '../../web/js/streaming.js';

const key = 'ab'.repeat(32);
const target = { controlId: 'app-1', dataId: 'data-1', bindingId: 'binding-1', frameKey: key };
const event = (seq = 0, extra = {}) => ({ action: 'stream_delta', sessionId: 'session', turnId: 'turn', seq, chunk: 'text', ...extra });
const credentials = () => ({ accessKeyId: 'ASIATEST', secretAccessKey: 'secret', sessionToken: 'token', expiresAt: Math.floor(Date.now() / 1000) + 900 });

function senderHarness(context, targets = [target], options = {}) {
  const frames = [];
  const fallback = [];
  const requests = [];
  const sender = new RealtimeSender({ resolveTimeout: options.resolveTimeout || 100,
    send(payload) {
      const message = JSON.parse(payload);
      if (message.action === 'realtime_direct_data') {
        frames.push(message);
        return options.dataSend ? options.dataSend(message) : true;
      }
      requests.push(message);
      if (message.op === 'resolve' && !options.noResolve) queueMicrotask(() => sender.handle({
        action: 'realtime_direct', v: 1, type: 'targets', requestId: message.requestId, targets,
      }));
      return true;
    }, fallback: message => fallback.push(message) });
  sender.handle({ action: 'realtime_direct', v: 1, type: 'credentials', endpoint: 'https://data.example.test/v1',
    region: 'ap-northeast-1', credentials: credentials() });
  context.after(() => sender.dispose());
  const drain = () => Promise.all([...sender.queues.values()]);
  return { sender, frames, fallback, requests, drain };
}

test('realtime events bypass Lambda without changing their sequence or frontend payload', async context => {
  const harness = senderHarness(context);
  for (let seq = 0; seq < 4; seq++) assert.equal(harness.sender.enqueue(event(seq, { replyConnectionId: 'app-1' })), true);
  await harness.drain();
  assert.equal(harness.fallback.length, 0);
  assert.equal(harness.requests.filter(request => request.op === 'resolve').length, 1);
  for (let seq = 0; seq < 4; seq++) {
    const envelope = JSON.parse(harness.frames[seq].body);
    assert.equal(await verifyFrame(envelope, key), true);
    assert.equal(harness.frames[seq].action, 'realtime_direct_data');
    assert.deepEqual(JSON.parse(envelope.payload).event, event(seq));
  }
});

test('history messages and control commands do not enter the direct path', context => {
  const { sender } = senderHarness(context);
  assert.equal(sender.enqueue(event(0, { action: 'messages', messages: [] })), false);
  assert.equal(sender.enqueue({ action: 'send_message', text: 'hello' }), false);
  assert.equal(sender.enqueue(event(0, { action: 'permission_request', turnId: '' })), false);
});

test('live noCache authority and permission events keep the existing wire contract', async context => {
  const harness = senderHarness(context);
  const message = event(0, { action: 'messages', noCache: true, messages: [{ uuid: 'native', content: 'hello' }] });
  harness.sender.enqueue(message);
  harness.sender.enqueue(event(1, { action: 'permission_resolved' }));
  await harness.drain();
  assert.deepEqual(JSON.parse(JSON.parse(harness.frames[0].body).payload).event, realtimePayload(message));
  assert.equal(harness.frames.length, 2);
});

test('multiple direct tabs receive individually bound frames and legacy tabs use targeted fallback', async context => {
  const second = { ...target, controlId: 'app-2', dataId: 'data-2', bindingId: 'binding-2', frameKey: 'cd'.repeat(32) };
  const harness = senderHarness(context, [target, second, { controlId: 'legacy' }]);
  harness.sender.enqueue(event());
  await harness.drain();
  assert.deepEqual(harness.frames.map(frame => frame.target), ['data-1', 'data-2']);
  assert.equal(await verifyFrame(JSON.parse(harness.frames[1].body), second.frameKey), true);
  assert.deepEqual(harness.fallback, [{ ...event(), directDeliveredTo: ['app-1', 'app-2'] }]);
});

test('oversized signed frames fall back intact before any direct delivery', async context => {
  const harness = senderHarness(context);
  const oversized = event(0, { chunk: 'x'.repeat(28000) });
  harness.sender.enqueue(oversized);
  await harness.drain();
  assert.equal(harness.frames.length, 0);
  assert.deepEqual(harness.fallback, [oversized]);
});

test('resolver timeout and absent capabilities preserve Lambda delivery', async context => {
  const harness = senderHarness(context, [target], { noResolve: true, resolveTimeout: 10 });
  harness.sender.enqueue(event());
  await harness.drain();
  assert.deepEqual(harness.fallback, [event()]);
  harness.sender.handle({ action: 'realtime_direct', v: 1, type: 'unsupported' });
  assert.equal(harness.sender.enqueue(event(1)), false);
});

test('subscription invalidation forces a fresh target lookup', async context => {
  const harness = senderHarness(context);
  harness.sender.enqueue(event());
  await harness.drain();
  harness.sender.handle({ action: 'realtime_direct', v: 1, type: 'invalidate', sessionId: 'session' });
  harness.sender.enqueue(event(1));
  await harness.drain();
  assert.equal(harness.requests.filter(request => request.op === 'resolve').length, 2);
});

test('backpressure only excludes direct recipients actually queued for delivery', async context => {
  const harness = senderHarness(context, [target], { dataSend: () => false });
  harness.sender.enqueue(event());
  await harness.drain();
  assert.deepEqual(harness.fallback, [{ ...event(), directDeliveredTo: [] }]);
});

test('disposing a connection rejects pending resolution without replay on the next connection', async context => {
  const harness = senderHarness(context, [target], { noResolve: true });
  harness.sender.enqueue(event());
  await new Promise(resolve => setImmediate(resolve));
  harness.sender.dispose();
  await harness.drain();
  assert.equal(harness.frames.length, 0);
  assert.equal(harness.fallback.length, 0);
});

test('queued events retain the same send-time JSON snapshot as the original transport', async context => {
  const harness = senderHarness(context);
  const message = event(0, { action: 'messages', noCache: true, messages: [{ uuid: 'native', content: 'before' }] });
  harness.sender.enqueue(message);
  message.messages[0].content = 'after';
  await harness.drain();
  assert.equal(JSON.parse(JSON.parse(harness.frames[0].body).payload).event.messages[0].content, 'before');
});

test('expired credentials fall back without losing the event or sending a partial fanout', async context => {
  const harness = senderHarness(context);
  harness.sender.authorization.credentials.expiresAt = Math.floor(Date.now() / 1000) - 1;
  harness.sender.enqueue(event());
  await harness.drain();
  assert.equal(harness.frames.length, 0);
  assert.deepEqual(harness.fallback, [event()]);
});

test('immediate disposal does not start queued RPCs after the connection is closed', async context => {
  const harness = senderHarness(context);
  harness.sender.enqueue(event());
  harness.sender.dispose();
  await harness.drain();
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.frames.length, 0);
});

function receiverHarness(context) {
  const controls = [];
  const sockets = [];
  const received = [];
  const receiver = new RealtimeReceiver({ control: { readyState: 1, send: payload => controls.push(JSON.parse(payload)) },
    key: 'account-key', receive: message => received.push(message), socketFactory(url) {
      const socket = { url, sent: [], close() {}, send(payload) { this.sent.push(JSON.parse(payload)); } };
      sockets.push(socket);
      return socket;
    } });
  context.after(() => receiver.dispose());
  receiver.start();
  const requestId = controls[0].requestId;
  receiver.handle({ action: 'realtime_direct', v: 1, type: 'offer', requestId, bindingId: 'binding-1',
    controlId: 'app-1', endpoint: 'https://data.example.test/v1', joinToken: 'join' });
  sockets[0].onopen();
  const ready = () => receiver.handle({ action: 'realtime_direct', v: 1, type: 'ready', requestId,
    bindingId: 'binding-1', frameKey: key });
  const frame = async message => JSON.stringify(await authenticateFrame(JSON.stringify({ action: 'realtime_direct_frame',
    v: 1, bindingId: 'binding-1', event: message }), key));
  return { receiver, controls, sockets, received, ready, frame };
}

test('receiver preserves raw arrival order and existing TurnEventQueue still sorts it', async context => {
  const harness = receiverHarness(context);
  harness.ready();
  for (const seq of [0, 2, 1]) harness.receiver.accept(await harness.frame(event(seq,
    { action: seq === 0 ? 'stream_turn_start' : 'stream_delta' })));
  await harness.receiver.queue;
  assert.deepEqual(harness.received.map(message => message.seq), [0, 2, 1]);
  const queue = new TurnEventQueue();
  assert.deepEqual(harness.received.flatMap(message => queue.push(message)).map(message => message.seq), [0, 1, 2]);
  assert.equal(harness.sockets[0].sent[0].op, 'join');
});

test('receiver buffers early frames but rejects forged data and control commands', async context => {
  const harness = receiverHarness(context);
  harness.receiver.accept(await harness.frame(event()));
  assert.equal(harness.received.length, 0);
  harness.ready();
  const valid = JSON.parse(await harness.frame(event(1)));
  valid.mac = '00'.repeat(32);
  harness.receiver.accept(JSON.stringify(valid));
  harness.receiver.accept(await harness.frame(event(2, { action: 'send_message' })));
  harness.receiver.accept(JSON.stringify({ action: 'realtime_direct', type: 'ready', frameKey: key }));
  await harness.receiver.queue;
  assert.deepEqual(harness.received, [event()]);
});

test('an in-flight signature verification cannot deliver into a disposed binding', async context => {
  const harness = receiverHarness(context);
  harness.ready();
  harness.receiver.accept(await harness.frame(event()));
  const queue = harness.receiver.queue;
  harness.receiver.dispose();
  await queue;
  assert.equal(harness.received.length, 0);
});
