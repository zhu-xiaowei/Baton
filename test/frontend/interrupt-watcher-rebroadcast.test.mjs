import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearLiveMessageRegistry,
  registerClaudeInterruptTurn,
} from '../../bridge/live-message-registry.mjs';
import { correlateClaudeInterruptMessage } from '../../bridge/watcher.mjs';
import { makeHarness, resetSession } from './harness.mjs';

function turnEvent(sessionId, turnId, seq, action, extra = {}) {
  return { action, sessionId, turnId, seq, ...extra };
}

test('live, watcher and full-sync copies of one interrupt keep one row', async context => {
  context.after(clearLiveMessageRegistry);
  const h = await makeHarness();
  const sessionId = 'claude:interrupt-watcher-rebroadcast';
  const turnId = 'sent-interrupted';
  const interruptId = `live_interrupt_${turnId}`;
  resetSession(h, { sessionId });
  h.state.appState.runtime = 'claude';

  for (const event of [
    turnEvent(sessionId, turnId, 0, 'stream_turn_start'),
    turnEvent(sessionId, turnId, 1, 'messages', {
      messages: [{
        uuid: 'observed-user',
        type: 'user',
        content: 'observed question',
      }],
    }),
    turnEvent(sessionId, turnId, 2, 'stream_block_start', {
      kind: 'text',
    }),
    turnEvent(sessionId, turnId, 3, 'stream_delta', {
      chunk: 'observed partial answer',
    }),
    turnEvent(sessionId, turnId, 4, 'messages', {
      messages: [{
        uuid: interruptId,
        nativeId: `live:interrupt:${turnId}`,
        type: 'user',
        content: [{
          type: 'text',
          text: '[Request interrupted by user]',
        }],
        timestamp: '2026-09-01T09:18:42.097Z',
      }],
    }),
  ]) {
    h.hooks.handleWsMessage(event);
  }
  await h.tick(30);

  const nativeInterrupt = {
    uuid: 'native-interrupt',
    type: 'user',
    content: [{
      type: 'text',
      text: '[Request interrupted by user]',
    }],
    timestamp: '2026-09-01T09:18:42.101Z',
  };
  registerClaudeInterruptTurn(sessionId, turnId);
  h.hooks.handleWsMessage({
    action: 'messages',
    sessionId,
    messages: [correlateClaudeInterruptMessage(sessionId, nativeInterrupt)],
  });
  await h.tick(30);

  assert.equal(
    h.document.querySelectorAll('.msg-interrupt').length,
    1,
    'the strict live message and watcher authority share one logical identity',
  );
  assert.equal(
    h.document.querySelector('.msg-interrupt')?.dataset.messageId,
    interruptId,
  );

  h.hooks.handleWsMessage({
    action: 'messages',
    sessionId,
    messages: [nativeInterrupt],
  });
  await h.tick(30);

  assert.equal(h.document.querySelectorAll('.msg-interrupt').length, 1);
  assert.equal(
    h.state.wsAllMessages.filter(message => h.window.isInterruptMsg(message)).length,
    1,
  );
});
