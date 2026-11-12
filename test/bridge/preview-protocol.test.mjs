import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import {
  createHeaderSigner, isStreamFrame, packStreamMessage, streamFrame, unpackStreamMessage,
} from '../../bridge/direct-rpc-protocol.mjs';
import { validatePreviewMessage } from '../../bridge/preview-protocol.mjs';

const sign = createHeaderSigner({
  endpoint: 'https://example.execute-api.ap-northeast-1.amazonaws.com/v1',
  region: 'ap-northeast-1', target: 'connection123', action: 'push',
  credentials: {
    accessKeyId: 'ASIAEXAMPLE', secretAccessKey: 'secret',
    sessionToken: 't'.repeat(1500), expiresAt: Math.floor(Date.now() / 1000) + 900,
  },
});
const signedSize = async (frame) => Buffer.byteLength(await sign(JSON.stringify(frame), undefined, { stream: frame.ch }));

test('the largest preview and terminal stream messages fit a signed frame', async () => {
  const message = validatePreviewMessage({
    type: 'bytes', streamId: randomUUID(), seq: 1,
    data: Buffer.alloc(16 * 1024, 0xff).toString('base64'),
  }, 'bridge');
  assert.throws(() => validatePreviewMessage({
    ...message, data: Buffer.alloc(16 * 1024 + 1).toString('base64'),
  }, 'bridge'), /Invalid preview data/);
  const preview = streamFrame('preview', randomUUID(), 'bridge', message);
  assert.ok(isStreamFrame(preview));
  assert.ok(await signedSize(preview) <= 28 * 1024);
  // terminal-shared sends packed output up to 20000 characters, otherwise 16 KiB plain chunks.
  const packed = { eventSeq: 1e9, epoch: 1e9, type: 'output', data: 'A'.repeat(20000), z: 1 };
  assert.ok(await signedSize(streamFrame('terminal', randomUUID(), 'bridge', packed)) <= 28 * 1024);
});

test('stream data is deflated only when it pays and unpacks to the same bytes', async () => {
  const text = Buffer.from('$ ls -la\r\n'.repeat(2000)).toString('base64');
  const packed = await packStreamMessage({ type: 'output', data: text }, deflateRawSync);
  assert.equal(packed.z, 1);
  assert.ok(packed.data.length < text.length / 10);
  assert.deepEqual(await unpackStreamMessage(packed, inflateRawSync), { type: 'output', data: text });
  const noise = randomBytes(4096).toString('base64');
  assert.equal((await packStreamMessage({ type: 'output', data: noise }, deflateRawSync)).z, undefined);
  assert.equal((await packStreamMessage({ type: 'output', data: text }, null)).z, undefined);
  assert.equal(isStreamFrame({ v: 2, kind: 'stream', ch: 'other', id: 'a', from: 'bridge', m: {} }), false);
});
