import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FetchBarrier,
  FetchBarrierCoordinator,
} from '../../web/js/fetch-barrier.js';

test('FetchBarrier buffers raw WS events in arrival order', () => {
  const barrier = new FetchBarrier({
    sessionId: 'session-1',
  });

  const events = [
    { action: 'messages', messages: [{ uuid: 'history' }] },
    { action: 'stream_delta', seq: 3, chunk: 'text' },
    { action: 'stream_end', seq: 4 },
  ];
  for (const event of events) assert.equal(barrier.capture(event), true);
  assert.deepEqual(barrier.events, events);
});

test('FetchBarrier stops accepting messages once commit begins', () => {
  const barrier = new FetchBarrier({ sessionId: 'session-1' });

  assert.equal(barrier.beginCommit(), true);
  assert.equal(barrier.capture({ action: 'messages' }), false);
  assert.deepEqual(barrier.events, []);
  assert.equal(barrier.close(), true);
  assert.equal(barrier.isOpen(), false);
});

test('FetchBarrierCoordinator invalidates stale generations', () => {
  const coordinator = new FetchBarrierCoordinator();
  const first = coordinator.open({ sessionId: 'session-1' });
  const second = coordinator.open({ sessionId: 'session-2' });

  assert.equal(first.state, 'invalid');
  assert.equal(coordinator.isCurrent(first), false);
  assert.equal(coordinator.isCurrent(second), true);
  assert.equal(coordinator.current('session-1'), null);
  assert.equal(coordinator.current('session-2'), second);
  assert.equal(coordinator.close(second), true);
  assert.equal(coordinator.current('session-2'), null);
});
