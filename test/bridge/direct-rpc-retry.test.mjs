// The App transport against a real DirectRpcBridge with injected faults; one worker per scenario.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { deflateRawSync } from 'node:zlib';
import { DirectRpcBridge } from '../../bridge/direct-rpc.mjs';
import { rpcResultFrames } from '../../bridge/direct-rpc-protocol.mjs';

const ENDPOINT = 'https://data.execute-api.ap-northeast-1.amazonaws.com/v1';
const credentials = () => ({ accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'TOKEN', expiresAt: Math.floor(Date.now() / 1000) + 3600 });
// Hashes barely compress, so the reply spans several chunks (the same list is built in the fixture).
const big = { items: Array.from({ length: 1500 }, (_, i) => createHash('sha256').update(String(i)).digest('hex')) };
const run = (options) => new Promise((resolve, reject) => {
  const worker = new Worker(new URL('./fixtures/direct-rpc-retry-scenario.mjs', import.meta.url), { workerData: options });
  worker.once('message', (result) => { resolve(result); worker.terminate(); });
  worker.once('error', reject);
});

test('resends keep their requestId: the Bridge computes once and replies once', async () => {
  const [normal, lost, late, slow, chunk, silent, offline, reconnect] = await Promise.all([
    run({}),
    run({ dropRequests: 1 }),
    run({ coldStart: true, devicesDelayMs: 7000, dropRequests: 1 }),
    run({ computeMs: 8000 }),
    run({ dropChunks: [1], big: true }),
    run({ silent: true }),
    run({ online: false }),
    run({ computeMs: 1500, reconnectAt: 300 }),
  ]);
  assert.deepEqual([normal.value, normal.requests, normal.computed, normal.slowAt], [{ ok: 1 }, 1, 1, null], 'normal');

  assert.deepEqual(lost.value, { ok: 1 }, 'a lost request');
  assert.equal(lost.requests, 2);
  assert.ok(lost.slowAt >= 6000 && lost.ms < 7000, 'resent at 6 s');

  assert.deepEqual([late.value, late.requests], [{ ok: 1 }, 2], 'a first send held back 7 s is still resent');
  assert.ok(late.ms > 9000 && late.ms < 10000, '2 s after it went out');

  assert.deepEqual(slow.value, { ok: 1 }, 'a slow Bridge');
  assert.equal(slow.computed, 1, 'the resend during computation is not recomputed');
  assert.equal(slow.chunksSent, 1, 'and the reply is sent once');
  assert.ok(slow.slowAt >= 6000 && slow.ms >= 8000);

  const chunks = rpcResultFrames('x', big, { deflate: deflateRawSync }).length;
  assert.ok(chunks >= 3, 'a multi-chunk reply');
  assert.deepEqual(chunk.value, big, 'a lost chunk');
  assert.equal(chunk.computed, 1);
  assert.equal(chunk.requests, 2);
  assert.equal(chunk.chunksSent, chunks + 1, 'only the missing chunk is sent again');

  assert.equal(silent.error, 'timeout', 'a silent Bridge fails at 12 s');
  assert.equal(silent.requests, 2, 'after exactly one resend');
  assert.ok(silent.slowAt >= 6000 && silent.ms >= 12000 && silent.ms < 13000);

  assert.equal(offline.error, 'offline', 'an offline device fails at once');
  assert.ok(offline.ms < 1000);

  assert.deepEqual(reconnect.value, { ok: 1 }, 'a reconnect mid-request');
  assert.equal(reconnect.computed, 1, 'the resend after reconnecting is not recomputed');
  assert.equal(reconnect.chunksSent, 1, 'the reply goes once, to the new connection');
});

test('a resend after the reply went out gets only the missing chunks from the stored reply', async () => {
  const sent = [];
  const bridge = new DirectRpcBridge({ key: 'key', sendControl: () => true, handlers: { work: async () => big } });
  bridge.auth = { endpoint: ENDPOINT, region: 'ap-northeast-1', credentials: credentials() };
  const socket = { readyState: 1, send: (text) => sent.push(JSON.parse(JSON.parse(text).body)) };
  bridge.socket = socket;
  const request = (missing) => JSON.stringify({ v: 2, kind: 'rpc', requestId: 'r1', method: 'work', params: {}, replyTo: 'app=', accept: ['deflate'], ...(missing ? { missing } : {}) });
  bridge.receive(socket, request());
  await new Promise((r) => setTimeout(r, 200));
  const count = sent.length;
  assert.ok(count >= 3);
  bridge.receive(socket, request([1, 2]));
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(sent.slice(count).map((frame) => frame.chunk.index), [1, 2]);
  bridge.receive(socket, request());
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sent.length, count * 2 + 2, 'a full resend repeats every stored chunk');
  bridge.receive(socket, request(5)); // not a chunk list: the whole reply again
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sent.length, count * 3 + 2);
});

test('receipts, a dead socket and expiring credentials', async () => {
  const [slow, lost, dead, appCredentials, bridgeCredentials] = await Promise.all([
    run({ ack: true, computeMs: 14000 }),
    run({ ack: true, dropRequests: 1 }),
    run({ deadSockets: [1] }),
    run({ appExpiresIn: 2 }),
    run({ bridgeExpiresIn: 2 }),
  ]);
  assert.deepEqual([slow.value, slow.computed], [{ ok: 1 }, 1], 'a receipted request may take longer than 12 s');
  assert.ok(slow.acceptedAt < 1000 && slow.ms >= 14000, 'the receipt arrives at once, the result when it is ready');

  assert.deepEqual([lost.value, lost.computed, lost.requests], [{ ok: 1 }, 1, 2], 'a request without its receipt is sent again');
  assert.ok(lost.acceptedAt >= 3000 && lost.acceptedAt < 4000, 'after 3 s');

  assert.deepEqual([dead.value, dead.computed], [{ ok: 1 }, 1], 'a socket that swallows frames is rebuilt');
  assert.ok(dead.ms >= 6000 && dead.ms < 7500, '3 s without a frame, then 3 s without a pong');

  assert.deepEqual([appCredentials.value, appCredentials.fetches], [{ ok: 1 }, 2], 'the App renews expiring credentials before signing');
  assert.deepEqual([bridgeCredentials.value, bridgeCredentials.credentialRequests], [{ ok: 1 }, 1], 'and so does the Bridge');
  assert.ok(bridgeCredentials.ms < 1000);
});

test('a long message is sent as compressed chunks and arrives whole', async () => {
  // About 200 000 characters that barely compress (hashes), with quotes, backslashes and CJK.
  const text = Array.from({ length: 3000 }, (_, i) => `日志 "${createHash('sha256').update(String(i)).digest('hex')}" \\\n`).join('');
  const [result, lost] = await Promise.all([run({ ack: true, text }), run({ ack: true, text, dropRequests: 1 })]);
  assert.deepEqual([result.value, result.computed], [{ length: text.length }, 1]);
  assert.ok(result.requests > 1, 'several frames');
  assert.deepEqual([lost.value, lost.computed], [{ length: text.length }, 1], 'a lost chunk is sent again');
});

test('pushes reach subscribers only, whole, and follow a reconnect', async () => {
  const result = await run({ push: true });
  assert.equal(result.unsubscribed, 0, 'nothing is sent for a Session nobody watches');
  assert.deepEqual(result.first.map((event) => event.seq), [1, 2], 'only the subscribed Session, in order');
  assert.ok(result.bigIntact, 'a large event arrives complete from several chunks');
  assert.deepEqual(result.afterReconnect.map((event) => event.seq), [3], 'the new connection is subscribed again');
  assert.deepEqual(result.subscribes, [{ to: 'app1=', renew: false }, { to: 'app2=', renew: false }]);
  assert.deepEqual(result.resyncs, ['all', 'dev'], 'the page reloads after a reconnect and when the Bridge restarted');
  assert.equal(result.sentAfterLeave, 0, 'and nothing after it left');
});
