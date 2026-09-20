import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

test('completed recovery replaces the old pending bubble with REST history', async () => {
  const h = await makeHarness();
  const sessionId = 'codex:foreground-acked-pending';
  resetSession(h, { sessionId });
  h.state.appState.runtime = 'codex';
  h.state.ws = {
    readyState: WebSocket.OPEN,
    send() {},
  };

  h.window.doSend('already accepted prompt', 'already accepted prompt', []);
  const pending = h.state.pendingSentMessages[0];
  const originalBubble = h.document.getElementById(pending.id);
  h.hooks.handleWsMessage({
    action: 'send_message_result',
    sessionId,
    turnId: pending.id,
    ok: true,
  });

  h.setApiResponse({
    messages: [
      {
        uuid: 'server-user',
        nativeId: 'codex:user:' + pending.id,
        type: 'user',
        content: 'already accepted prompt',
        timestamp: '2026-08-26T06:00:00.000Z',
      },
      {
        uuid: 'server-answer',
        nativeId: 'codex:item:answer',
        type: 'assistant',
        content: [{ type: 'text', text: 'completed answer' }],
        timestamp: '2026-08-26T06:00:01.000Z',
        stopReason: 'end_turn',
      },
    ],
    hasMore: false,
    needSync: false,
    status: 'completed',
  });

  const loading = h.window.loadLatestMessages(sessionId);
  await h.tick(40);

  assert.equal(h.state.wsRunning, false);
  assert.equal(h.state.pendingSentMessages.includes(pending), false);
  assert.equal(originalBubble.isConnected, false);
  const restored = h.document.querySelector(`[data-anchor="${pending.id}"]`);
  assert.ok(restored);
  assert.equal(restored.hasAttribute('data-pending'), false);
  assert.equal(restored.dataset.messageId, 'server-user');
  assert.equal(
    restored.dataset.nativeId,
    'codex:user:' + pending.id,
  );
  assert.equal(
    (h.document.querySelector('.messages').textContent
      .match(/already accepted prompt/g) || []).length,
    1,
  );
  assert.match(
    h.document.querySelector('.messages').textContent,
    /completed answer/,
  );
});
