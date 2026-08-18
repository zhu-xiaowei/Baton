import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

function deferred() {
  var resolve;
  var promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function event(sessionId, turnId, seq, action, extra = {}) {
  return { action, sessionId, turnId, seq, ...extra };
}

test('late join authority joins the REST buffer and never renders partial delta', async () => {
  const h = await makeHarness();
  const sessionId = 'codex:entry-late';
  const turnId = 'turn-entry-late';
  resetSession(h, { sessionId });
  const request = deferred();
  h.setApiHandler(() => request.promise);

  const loading = h.window.bufferAndFetch(sessionId, '');
  await h.tick(0);
  h.hooks.handleWsMessage(
    event(sessionId, turnId, 3, 'stream_delta', { chunk: 'partial' }),
  );
  h.hooks.handleWsMessage(event(sessionId, turnId, 4, 'messages', {
    messages: [{
      uuid: 'late-answer',
      nativeId: 'codex:item:late-answer',
      type: 'assistant',
      content: [{ type: 'text', text: 'complete answer' }],
      timestamp: '2026-08-17T00:00:01.000Z',
    }],
  }));
  h.hooks.handleWsMessage(event(sessionId, turnId, 5, 'stream_end'));

  assert.equal(h.document.body.textContent.includes('partial'), false);
  assert.equal(h.document.body.textContent.includes('complete answer'), false);

  request.resolve({
    messages: [{
      uuid: 'history',
      type: 'user',
      content: 'question',
      timestamp: '2026-08-17T00:00:00.000Z',
    }],
    hasMore: false,
  });
  await loading;

  h.document.querySelector('.messages').innerHTML = h.window.renderMessages(
    h.state.wsAllMessages,
    'codex',
  );
  assert.equal(h.document.body.textContent.includes('partial'), false);
  assert.equal(
    h.document.body.textContent.split('complete answer').length - 1,
    1,
  );
});
