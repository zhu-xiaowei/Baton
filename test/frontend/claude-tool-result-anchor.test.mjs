import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

test('a tool result cannot claim the turn prompt anchor', async () => {
  const h = await makeHarness();
  const sessionId = 'claude:tool-result-anchor';
  resetSession(h, { sessionId });
  h.state.appState.runtime = 'claude';
  h.state.ws = {
    readyState: h.window.WebSocket.OPEN,
    send() {},
    close() {},
  };
  h.window.doSend('run the command', 'run the command', []);
  const pending = h.state.pendingSentMessages[0];
  const originalBubble = h.document.getElementById(pending.id);
  h.window.isToolResultOnly = globalThis.isToolResultOnly = (message) =>
    message.type === 'user'
    && Array.isArray(message.content)
    && message.content.length > 0
    && message.content.every((block) => block.type === 'tool_result');

  h.hooks.handleWsMessage({
    action: 'stream_turn_start',
    sessionId,
    turnId: pending.id,
    seq: 0,
  });
  h.hooks.handleWsMessage({
    action: 'messages',
    sessionId,
    turnId: pending.id,
    seq: 1,
    messages: [{
      uuid: 'tool-result-1',
      type: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: 'command output',
      }],
    }],
  });

  assert.equal(h.document.getElementById(pending.id), originalBubble);
  assert.equal(h.state.pendingSentMessages.length, 1);

  h.hooks.handleWsMessage({
    action: 'messages',
    sessionId,
    turnId: pending.id,
    seq: 2,
    messages: [{
      uuid: 'prompt-echo-1',
      type: 'user',
      content: 'run the command',
    }],
  });

  assert.equal(h.document.getElementById(pending.id), originalBubble);
  assert.equal(originalBubble.dataset.anchor, pending.id);
  assert.equal(originalBubble.hasAttribute('data-pending'), false);
  assert.equal(h.state.pendingSentMessages.length, 0);
});
