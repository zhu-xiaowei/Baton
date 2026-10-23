import assert from 'node:assert/strict';
import test from 'node:test';
import { createDownloadQueue } from '../../web/js/project/download-queue.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('queue serializes tasks, waits for cancellation cleanup, and retries at the tail', async () => {
  const runs = [], events = [];
  const queue = createDownloadQueue((target, signal, update) => {
    const gate = deferred(); runs.push({ target, signal, update, gate }); return gate.promise;
  }, (item, event) => events.push([item.id, item.state, event]));
  const a = queue.enqueue({ name: 'a' });
  const b = queue.enqueue({ name: 'b' });
  const c = queue.enqueue({ name: 'c' });
  assert.equal(runs.length, 1);
  queue.cancel(a.id);
  assert.equal(a.state, 'cancelling');
  runs[0].update({ state: 'transferring', progress: { received: 90 } });
  assert.equal(a.state, 'cancelling');
  await tick(); assert.equal(runs.length, 1);
  runs[0].gate.reject(runs[0].signal.reason);
  await a.done;
  assert.equal(a.state, 'cancelled');
  assert.equal(runs[1].target.name, 'b');
  queue.retry(a.id);
  runs[1].gate.resolve({ status: 'saved' }); await b.done;
  assert.equal(runs[2].target.name, 'c');
  runs[2].gate.resolve({ status: 'started' }); await c.done;
  assert.equal(runs[3].target.name, 'a');
  runs[3].gate.resolve({ status: 'saved' }); await a.done;
  assert.equal(queue.pending, 0);
  assert.ok(events.some(event => event[1] === 'cancelling'));
});

test('cancelAll never starts queued work and unconfirmed cancellation stays an error', async () => {
  const gate = deferred(); let calls = 0;
  const queue = createDownloadQueue(() => { calls++; return gate.promise; });
  const a = queue.enqueue({ name: 'a' }), b = queue.enqueue({ name: 'b' });
  const cancelled = queue.cancelAll();
  const error = Object.assign(new Error('Cancellation not confirmed'), { code: 'DOWNLOAD_CANCEL_UNCONFIRMED' });
  gate.reject(error); await cancelled;
  assert.equal(calls, 1); assert.equal(b.state, 'cancelled');
  assert.equal(a.state, 'error'); assert.equal(a.error, error); assert.equal(queue.pending, 0);
});

test('unknown results fail, confirmed saves win late cancellation, and targets are snapshots', async () => {
  const gate = deferred();
  const target = { name: 'original', device: 'one' };
  const queue = createDownloadQueue(() => gate.promise);
  const item = queue.enqueue(target); target.device = 'two';
  assert.equal(item.target.device, 'one');
  queue.cancel(item.id); gate.resolve({ status: 'saved' }); await item.done;
  assert.equal(item.state, 'success');
  const invalid = createDownloadQueue(async () => ({ status: 'unknown' })).enqueue({});
  await invalid.done; assert.equal(invalid.state, 'error');
});
