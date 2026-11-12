import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { RpcAssembler, createHeaderSigner, decodeRpcPayload, rpcErrorFrame, rpcResultFrames } from '../../bridge/direct-rpc-protocol.mjs';

const big = { items: Array.from({ length: 2000 }, (_, i) => ({ id: i, preview: `${'中文'.repeat(20)} ✓ ${randomBytes(24).toString('hex')}` })) };

async function roundTrip(frames) {
  const assembler = new RpcAssembler();
  let done;
  for (const frame of frames) done = assembler.add(JSON.parse(JSON.stringify(frame))) || done;
  return done.error ? done : decodeRpcPayload(done.payload, inflateRawSync);
}

test('compressed results split into chunks and reassemble in any order', async () => {
  const frames = rpcResultFrames('r1', big, { deflate: deflateRawSync });
  assert.ok(frames.length > 1 && frames.every((f) => f.enc === 'deflate-b64'));
  assert.deepEqual(await roundTrip([...frames].reverse()), big);
});

test('small and uncompressed results stay JSON', async () => {
  const small = rpcResultFrames('r2', { ok: 1 }, { deflate: deflateRawSync });
  assert.equal(small[0].enc, 'json');
  assert.deepEqual(await roundTrip(small), { ok: 1 });
  const plain = rpcResultFrames('r3', big);
  assert.ok(plain.every((f) => f.enc === 'json'));
  assert.deepEqual(await roundTrip(plain), big);
});

test('errors end the request and every chunk fits a signed frame', async () => {
  assert.equal((await roundTrip([rpcErrorFrame('r4', 'unknown method')])).error, 'unknown method');
  const sign = createHeaderSigner({ endpoint: 'https://data.execute-api.ap-northeast-1.amazonaws.com/v1',
    region: 'ap-northeast-1', target: 'abc=', action: 'rpc',
    credentials: { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'T'.repeat(1200), expiresAt: Math.floor(Date.now() / 1000) + 3600 } });
  for (const frame of [...rpcResultFrames('r5', big, { deflate: deflateRawSync }), ...rpcResultFrames('r6', big)]) {
    await sign(JSON.stringify(frame));
  }
});
