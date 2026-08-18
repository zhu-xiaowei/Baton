import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearLiveMessage,
  clearLiveMessageRegistry,
  liveMessageRoute,
  markLiveMessagePushed,
  registerRuntimeOwnedMessage,
} from '../../bridge/live-message-registry.mjs';

test.afterEach(clearLiveMessageRegistry);

test('registry records runtime ownership before authority is published', () => {
  assert.equal(registerRuntimeOwnedMessage('codex', 'item-1'), true);
  assert.deepEqual(liveMessageRoute('codex', 'item-1'), {
    pushed: false,
    runtimeOwned: true,
  });
});

test('published authority remains marked for delayed JSONL persistence', () => {
  markLiveMessagePushed('claude', 'message-1');
  assert.deepEqual(
    liveMessageRoute('claude', 'message-1'),
    { pushed: true, runtimeOwned: false },
  );
});

test('clearing the registry removes ownership state', () => {
  registerRuntimeOwnedMessage('codex', 'item-1');
  clearLiveMessageRegistry();
  assert.equal(liveMessageRoute('codex', 'item-1'), null);
});

test('persisting a JSONL copy clears only its exact ownership key', () => {
  registerRuntimeOwnedMessage('codex', 'item-1');
  registerRuntimeOwnedMessage('codex', 'item-2');
  assert.equal(clearLiveMessage('codex', 'item-1'), true);
  assert.equal(liveMessageRoute('codex', 'item-1'), null);
  assert.equal(liveMessageRoute('codex', 'item-2')?.runtimeOwned, true);
});

test('pushed-message capacity follows Map insertion order after exact clears', () => {
  markLiveMessagePushed('claude', 'reused');
  clearLiveMessage('claude', 'reused');
  markLiveMessagePushed('claude', 'reused');
  for (let index = 0; index < 4095; index++) {
    markLiveMessagePushed('claude', `item-${index}`);
  }
  markLiveMessagePushed('claude', 'overflow');

  assert.equal(liveMessageRoute('claude', 'reused'), null);
  assert.equal(liveMessageRoute('claude', 'item-0')?.pushed, true);
  assert.equal(liveMessageRoute('claude', 'overflow')?.pushed, true);
});

test('runtime turn ownership is not evicted by pushed-message capacity', () => {
  registerRuntimeOwnedMessage('codex', 'runtime-turn:turn-1');
  for (let index = 0; index <= 4096; index++) {
    markLiveMessagePushed('claude', `message-${index}`);
  }

  assert.deepEqual(
    liveMessageRoute('codex', 'runtime-turn:turn-1'),
    { pushed: false, runtimeOwned: true },
  );
});
