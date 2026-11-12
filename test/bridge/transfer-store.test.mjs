import assert from 'node:assert/strict';
import test from 'node:test';
import { createTransferStore, presign, signUrl } from '../../bridge/transfer-store.mjs';

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

test('stored content is reused only while it outlives the day its writer remembers it', async () => {
  const day = 86400_000;
  const contentHash = 'c'.repeat(64);
  const checksum = Buffer.from(contentHash, 'hex').toString('base64');
  const access = async () => ({ bucket: 'b', region: 'ap-northeast-1', accountId: '0123456789abcdef', accelerate: false,
    credentials: { accessKeyId: 'A', secretAccessKey: 'S', sessionToken: 'T', expiresAt: Date.now() / 1000 + 3600 } });
  const prepare = (ageMs) => createTransferStore(access, async () => new Response(null, { status: 200, headers: {
    'content-length': '5', 'x-amz-checksum-sha256': checksum, 'last-modified': new Date(Date.now() - ageMs).toUTCString() } }))
    .prepareUpload({ name: 'a.txt', size: 5, contentHash });
  assert.deepEqual(await prepare(5 * day), { key: 'c'.repeat(32) + '.txt', exists: true });
  const old = await prepare(6.5 * day);
  assert.equal(old.key, 'c'.repeat(32) + '.txt');
  assert.ok(old.url && !old.exists, 'an object near its expiry is written again under the same key');
});
