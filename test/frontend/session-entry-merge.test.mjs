import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

function deferred() {
  var resolve;
  var promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function turnEvent(sessionId, turnId, seq, action, extra = {}) {
  return { action, sessionId, turnId, seq, ...extra };
}

test('initial REST merges no-seq watcher messages before the first render', async () => {
  const h = await makeHarness();
  const sessionId = 'codex:entry-no-seq';
  resetSession(h, { sessionId });
  const request = deferred();
  h.setApiHandler(() => request.promise);

  const loading = h.window.bufferAndFetch(sessionId, '');
  await h.tick(0);
  h.hooks.handleWsMessage({
    action: 'messages',
    sessionId,
    messages: [{
      uuid: 'ws-copy',
      nativeId: 'codex:item:shared',
      type: 'assistant',
      content: [{ type: 'text', text: 'merged once' }],
      timestamp: '2026-08-17T00:00:01.000Z',
    }],
  });

  assert.equal(h.state.wsAllMessages.length, 0);
  assert.equal(h.document.querySelector('.messages').textContent, '');

  request.resolve({
    messages: [
      {
        uuid: 'history',
        type: 'user',
        content: 'question',
        timestamp: '2026-08-17T00:00:00.000Z',
      },
      {
        uuid: 'rest-copy',
        nativeId: 'codex:item:shared',
        type: 'assistant',
        content: [{ type: 'text', text: 'merged once' }],
        timestamp: '2026-08-17T00:00:01.000Z',
      },
    ],
    hasMore: false,
  });
  await loading;

  assert.equal(
    h.state.wsAllMessages.filter((message) =>
      message.nativeId === 'codex:item:shared').length,
    1,
  );
  h.document.querySelector('.messages').innerHTML = h.window.renderMessages(
    h.state.wsAllMessages,
    'codex',
  );
  assert.equal(
    h.document.body.textContent.split('merged once').length - 1,
    1,
  );
});
