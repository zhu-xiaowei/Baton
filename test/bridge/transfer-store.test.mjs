import assert from 'node:assert/strict';
import test from 'node:test';
import { createTransferStore, presign, RECORD, sealStream, setTransferKeys, signUrl } from '../../bridge/transfer-store.mjs';

test('query signatures match the AWS S3 example', async () => {
  // "Authenticating Requests: Using Query Parameters (AWS Signature Version 4)", S3 API Reference.
  const url = await signUrl({ method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', region: 'us-east-1',
    credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
    expires: 86400, now: new Date('2013-05-24T00:00:00Z') });
  assert.equal(new URL(url).searchParams.get('X-Amz-Signature'), 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
});

test('requests stay inside the account prefix and the credential lifetime', async () => {
  const now = new Date('2026-11-12T00:00:00Z');
  const access = { bucket: 'b', region: 'ap-northeast-1', accountId: '0123456789abcdef',
    credentials: { accessKeyId: 'A', secretAccessKey: 'S', sessionToken: 'T', expiresAt: now.getTime() / 1000 + 600 } };
  const url = new URL(await presign(access, 'GET', 'a'.repeat(32) + '.png', { now }));
  assert.equal(url.host, 'b.s3.ap-northeast-1.amazonaws.com');
  assert.equal(url.pathname, '/t/0123456789abcdef/' + 'a'.repeat(32) + '.png');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '595');
  await assert.rejects(presign(access, 'GET', '../other/x.png', { now }), /Invalid file key/);
  await assert.rejects(presign(access, 'GET', 'a'.repeat(32), { now: new Date(now.getTime() + 600_000) }), /expired/);
});

test('stored content is reused only while it outlives the hours its writer remembers it (S3)', async () => {
  const contentHash = 'c'.repeat(64);
  const checksum = Buffer.from(contentHash, 'hex').toString('base64');
  const access = async () => ({ bucket: 'b', region: 'ap-northeast-1', accountId: '0123456789abcdef', accelerate: false,
    credentials: { accessKeyId: 'A', secretAccessKey: 'S', sessionToken: 'T', expiresAt: Date.now() / 1000 + 3600 } });
  const prepare = (ageMs) => createTransferStore(access, async () => new Response(null, { status: 200, headers: {
    'content-length': '5', 'x-amz-checksum-sha256': checksum, 'last-modified': new Date(Date.now() - ageMs).toUTCString() } }))
    .prepareUpload({ name: 'a.txt', size: 5, contentHash });
  assert.deepEqual(await prepare(21 * 3600_000), { key: 'c'.repeat(32) + '.txt', exists: true, sealed: false, stored: 5 });
  const old = await prepare(22 * 3600_000);
  assert.equal(old.key, 'c'.repeat(32) + '.txt');
  assert.ok(old.url && !old.exists, 'an object near its expiry is written again under the same key');
});

test('a sealed stream reads back by record and stores nothing when its source fails at the end', async () => {
  const keys = { key: await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']), since: Date.now() };
  setTransferKeys(() => keys);
  const key = 'e'.repeat(32) + '.mp4';
  const plain = new Uint8Array(3 * RECORD + 5).map((_, i) => i * 7);
  const parts = []; for await (const record of sealStream(keys, key, plain.length, [plain.subarray(0, 100), plain.subarray(100)])) parts.push(record);
  const sealed = Buffer.concat(parts);
  const store = createTransferStore(async () => ({ bucket: 'b', region: 'r', accountId: 'a', credentials: { accessKeyId: 'A', secretAccessKey: 'S', expiresAt: Date.now() / 1000 + 600 } }),
    async (url, { headers }) => { const [, a, b] = /(\d+)-(\d+)/.exec(headers.Range); return new Response(sealed.subarray(+a, +b + 1), { status: 206 }); });
  const read = []; for await (const record of store.records(key, sealed.length, 1)) read.push(record);
  assert.deepEqual(Buffer.concat(read), Buffer.from(plain.subarray(RECORD)));
  const failing = (async function* () { yield plain; throw new Error('changed'); })();
  const out = []; await assert.rejects(async () => { for await (const record of sealStream(keys, key, plain.length, failing)) out.push(record); });
  assert.ok(out.length < 4, 'the last record waits for the source to end');
  setTransferKeys(() => null);
});
