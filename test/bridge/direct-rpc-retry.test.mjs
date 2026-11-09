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
