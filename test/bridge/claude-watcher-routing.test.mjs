import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldPersistClaudeJsonlMessage } from '../../bridge/watcher.mjs';

test('runtime-owned Claude JSONL rows are persistence-only', () => {
  assert.equal(shouldPersistClaudeJsonlMessage(true, null), true);
  assert.equal(shouldPersistClaudeJsonlMessage(false, {
    pushed: true,
    runtimeOwned: true,
  }), true);
});

test('external Claude JSONL rows remain realtime', () => {
  assert.equal(shouldPersistClaudeJsonlMessage(false, null), false);
  assert.equal(shouldPersistClaudeJsonlMessage(false, {
    pushed: false,
    runtimeOwned: false,
  }), false);
});
