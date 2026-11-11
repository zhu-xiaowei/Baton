import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearLiveMessageRegistry,
  registerClaudeInterruptTurn,
} from '../../bridge/live-message-registry.mjs';
import {
  correlateClaudeInterruptMessage,
  createClaudeFileQueue,
  claudeRowPushedLive,
  shouldSkipClaudeSession,
} from '../../bridge/watcher.mjs';

test.afterEach(clearLiveMessageRegistry);

test('parent file updates share one queue while child delivery stays independent', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let parentReads = 0;
  let active = 0;
  let maxActive = 0;
  let delivered = 0;
  const enqueue = createClaudeFileQueue({}, async (_config, _file, id, queue) => {
    if (id !== 'parent') {
      delivered++;
      queue('parent.jsonl', 'parent');
      return;
    }
    parentReads++;
    maxActive = Math.max(maxActive, ++active);
    if (parentReads === 1) await blocked;
    active--;
  });
  await Promise.all([enqueue('child-a.jsonl', 'child-a'), enqueue('child-b.jsonl', 'child-b')]);
  assert.equal(delivered, 2);
  assert.equal(parentReads, 1);
  release();
  await enqueue('parent.jsonl', 'parent');
  assert.equal(parentReads, 2);
  assert.equal(maxActive, 1);
});

test('runtime-owned Claude JSONL rows were pushed live', () => {
  assert.equal(claudeRowPushedLive(true, null), true);
  assert.equal(claudeRowPushedLive(false, {
    pushed: true,
    runtimeOwned: true,
  }), true);
});

test('external Claude JSONL rows are pushed by the watcher', () => {
  assert.equal(claudeRowPushedLive(false, null), false);
  assert.equal(claudeRowPushedLive(false, {
    pushed: false,
    runtimeOwned: false,
  }), false);
});

test('empty non-daemon Claude sessions are skipped regardless of running status', () => {
  assert.equal(shouldSkipClaudeSession('', null), true);
  assert.equal(shouldSkipClaudeSession('Real user prompt', null), false);
  assert.equal(shouldSkipClaudeSession('', { agentName: 'worker' }), false);
});

test('watcher preserves the native UUID while linking the Claude interrupt to its live turn', () => {
  registerClaudeInterruptTurn('session-1', 'sent-turn-1', 1_000);
  const message = correlateClaudeInterruptMessage('session-1', {
    uuid: 'claude-jsonl-uuid',
    type: 'user',
    content: [{ type: 'text', text: '[Request interrupted by user]' }],
    timestamp: '2026-09-01T09:18:42.101Z',
  }, 1_001);

  assert.deepEqual(message, {
    uuid: 'claude-jsonl-uuid',
    nativeId: 'live:interrupt:sent-turn-1',
    turnId: 'sent-turn-1',
    type: 'user',
    content: [{ type: 'text', text: '[Request interrupted by user]' }],
    timestamp: '2026-09-01T09:18:42.101Z',
  });
});

test('unrelated rows do not consume a pending Claude interrupt turn', () => {
  registerClaudeInterruptTurn('session-1', 'sent-turn-1', 1_000);
  const assistant = {
    uuid: 'assistant-1',
    type: 'assistant',
    content: [{ type: 'text', text: 'partial' }],
  };

  assert.equal(
    correlateClaudeInterruptMessage('session-1', assistant, 1_001),
    assistant,
  );
  assert.equal(
    correlateClaudeInterruptMessage('session-1', {
      uuid: 'claude-jsonl-uuid',
      type: 'user',
      content: [{
        type: 'text',
        text: '[Request interrupted by user for tool use]',
      }],
    }, 1_002).uuid,
    'claude-jsonl-uuid',
  );
});

test('external Claude interrupts retain their native JSONL identity', () => {
  const message = {
    uuid: 'external-interrupt',
    type: 'user',
    content: [{ type: 'text', text: '[Request interrupted by user]' }],
  };

  assert.equal(
    correlateClaudeInterruptMessage('session-1', message, 1_000),
    message,
  );
});
