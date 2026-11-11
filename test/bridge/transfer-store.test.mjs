import assert from 'node:assert/strict';
import test from 'node:test';
import { presign, signUrl } from '../../bridge/transfer-store.mjs';

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
  assert.equal(url.searchParams.get('X-Amz-Expires'), '570');
  await assert.rejects(presign(access, 'GET', '../other/x.png', { now }), /Invalid file key/);
  await assert.rejects(presign(access, 'GET', 'a'.repeat(32), { now: new Date(now.getTime() + 600_000) }), /expired/);
});
