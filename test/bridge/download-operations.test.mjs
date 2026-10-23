import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { createDownloadOperations } from '../../bridge/project/download-operations.mjs';

test('cancel before start is remembered, but another account can use its own token', async () => {
  const operations = createDownloadOperations();
  const token = crypto.randomUUID();
  assert.deepEqual(await operations.cancel('a', token), { status: 'cancelled' });
  assert.throws(() => operations.begin('a', token), /cancelled/);
  const other = operations.begin('b', token);
  assert.equal(other.signal.aborted, false);
  other.finish();
  assert.deepEqual(await operations.cancel('b', token), { status: 'completed' });
});

test('cancel acknowledges only after cleanup, is idempotent and rejects duplicate starts', async () => {
  const operations = createDownloadOperations();
  const token = crypto.randomUUID();
  const job = operations.begin('a', token);
  assert.throws(() => operations.begin('a', token), /already been used/);
  let acknowledged = false;
  const cancel = operations.cancel('a', token).then(result => { acknowledged = true; return result; });
  assert.equal(job.signal.aborted, true);
  await Promise.resolve();
  assert.equal(acknowledged, false);
  job.finish();
  assert.deepEqual(await cancel, { status: 'cancelled' });
  assert.deepEqual(await operations.cancel('a', token), { status: 'cancelled' });
});

test('history expires and remains bounded without evicting active work', async () => {
  let now = 0;
  const operations = createDownloadOperations({ now: () => now });
  const activeToken = crypto.randomUUID();
  const active = operations.begin('a', activeToken);
  const first = crypto.randomUUID();
  await operations.cancel('a', first);
  for (let n = 0; n < 256; n++) await operations.cancel('a', crypto.randomUUID());
  const reused = operations.begin('a', first);
  reused.finish();
  assert.throws(() => operations.begin('a', activeToken), /already been used/);
  now = 60_001;
  const expired = operations.begin('a', first);
  expired.finish();
  active.finish();
});

test('preparation has its own deadline even if the browser disappears', async () => {
  const operations = createDownloadOperations({ timeout: 10 });
  const job = operations.begin('a', crypto.randomUUID());
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(job.signal.aborted, true);
  assert.match(job.signal.reason.message, /timed out/);
  job.finish();
});

test('invalid owner or token is rejected without starting work', async () => {
  const operations = createDownloadOperations();
  assert.throws(() => operations.begin('', crypto.randomUUID()), /Invalid/);
  assert.throws(() => operations.begin('a', 'bad'), /Invalid/);
  await assert.rejects(operations.cancel('a', null), /Invalid/);
});
