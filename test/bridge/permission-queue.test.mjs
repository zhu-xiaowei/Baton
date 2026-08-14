import assert from 'node:assert/strict';
import test from 'node:test';
import { PermissionQueue } from '../../bridge/permission-queue.mjs';

const request = (requestId, command = requestId) => ({
  requestId,
  toolName: 'Bash',
  input: { command },
});

test('permission queue matches Codex TUI current plus LIFO behavior', () => {
  const queue = new PermissionQueue();

  assert.equal(queue.enqueue('session-1', request('first')).shouldPresent, true);
  assert.equal(queue.enqueue('session-1', request('second')).shouldPresent, false);
  assert.equal(queue.enqueue('session-1', request('third')).shouldPresent, false);
  assert.equal(queue.current('session-1').requestId, 'first');

  assert.equal(queue.resolve('session-1', 'second'), null);
  assert.equal(queue.resolve('session-1', 'first').next.requestId, 'third');
  assert.equal(queue.resolve('session-1', 'third').next.requestId, 'second');
  assert.equal(queue.resolve('session-1', 'second').next, null);
  assert.equal(queue.has('session-1'), false);
});

test('permission queue deduplicates replayed active and queued requests', () => {
  const queue = new PermissionQueue();

  queue.enqueue('session-1', request('first', 'old first'));
  queue.enqueue('session-1', request('second', 'old second'));
  assert.equal(
    queue.enqueue('session-1', request('first', 'new first')).shouldPresent,
    true,
  );
  assert.equal(
    queue.enqueue('session-1', request('second', 'new second')).shouldPresent,
    false,
  );

  assert.equal(queue.current('session-1').input.command, 'new first');
  assert.equal(queue.resolve('session-1', 'first').next.input.command, 'new second');
});

test('permission queue clears a session without affecting another session', () => {
  const queue = new PermissionQueue();
  queue.enqueue('session-1', request('first'));
  queue.enqueue('session-1', request('second'));
  queue.enqueue('session-2', request('other'));

  const cleared = queue.clear('session-1');
  assert.equal(cleared.current.requestId, 'first');
  assert.deepEqual(cleared.stack.map((item) => item.requestId), ['second']);
  assert.equal(queue.has('session-1'), false);
  assert.equal(queue.current('session-2').requestId, 'other');
});
