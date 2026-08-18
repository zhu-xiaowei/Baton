import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

test('no-seq watcher messages render incrementally after REST finishes', async () => {
  const h = await makeHarness();
  const sessionId = 'codex:entry-rest-first-history';
  resetSession(h, { sessionId });
  h.setApiHandler(async () => ({
    messages: [{
      uuid: 'history-user',
      type: 'user',
      content: 'old question',
      timestamp: '2026-08-17T00:00:00.000Z',
    }],
    hasMore: false,
  }));

  await h.window.bufferAndFetch(sessionId, '');
  const container = h.document.querySelector('.messages');
  container.innerHTML = h.window.renderMessages(h.state.wsAllMessages, 'codex');

  h.hooks.handleWsMessage({
    action: 'messages',
    sessionId,
    messages: [{
      uuid: 'watcher-answer',
      nativeId: 'codex:item:rest-first-answer',
      type: 'assistant',
      content: [{ type: 'text', text: 'watcher after REST' }],
      timestamp: '2026-08-17T00:00:01.000Z',
    }],
  });

  assert.equal(h.state._wsBuffer, null);
  assert.equal(
    h.state.wsAllMessages.filter((message) =>
      message.nativeId === 'codex:item:rest-first-answer').length,
    1,
  );
  assert.equal(
    container.textContent.split('watcher after REST').length - 1,
    1,
  );
});
