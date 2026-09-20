import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearLiveMessageRegistry,
  registerClaudeInterruptTurn,
} from '../../bridge/live-message-registry.mjs';
import {
  correlateClaudeInterruptMessage,
  pollAgentStates,
  resetAgentPollState,
  shouldPersistClaudeJsonlMessage,
  shouldSkipClaudeSession,
} from '../../bridge/watcher.mjs';

test.afterEach(clearLiveMessageRegistry);

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

test('failed realtime agent status push is retried on the next poll', async () => {
  resetAgentPollState();
  const agents = new Map([['agent-session-1', {
    agentName: 'worker',
    agentDetail: '',
    status: 'completed',
  }]]);
  let attempts = 0;
  const options = {
    agents,
    findSessionFile: () => '/tmp/agent-session-1.jsonl',
    poolOwns: () => false,
    getSessionMetadata: () => ({ preview: 'worker', model: 'test' }),
    pushAgentMeta: async () => {
      attempts++;
      if (attempts === 1) throw new Error('temporary server failure');
    },
  };

  await pollAgentStates({ deviceName: 'test' }, options);
  await pollAgentStates({ deviceName: 'test' }, options);
  await pollAgentStates({ deviceName: 'test' }, options);

  assert.equal(attempts, 2);
  resetAgentPollState();
});
