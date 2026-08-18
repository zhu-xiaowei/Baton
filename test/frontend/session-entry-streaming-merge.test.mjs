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

test('strict streaming survives the initial REST render and dedupes authority', async () => {
  const h = await makeHarness();
  const sessionId = 'codex:entry-streaming';
  const turnId = 'turn-entry-streaming';
  resetSession(h, { sessionId });
  const request = deferred();
  h.setApiHandler(() => request.promise);

  const loading = h.window.bufferAndFetch(sessionId, '');
  await h.tick(0);
  for (const item of [
    event(sessionId, turnId, 0, 'stream_turn_start'),
    event(sessionId, turnId, 1, 'messages', {
      messages: [{
        uuid: 'live-user',
        nativeId: 'codex:user:entry',
        type: 'user',
        content: 'question',
        timestamp: '2026-08-17T00:00:00.000Z',
      }],
    }),
    event(sessionId, turnId, 2, 'stream_block_start', { kind: 'text' }),
    event(sessionId, turnId, 3, 'stream_delta', { chunk: 'live answer' }),
  ]) {
    h.hooks.handleWsMessage(item);
  }

  request.resolve({
    messages: [
      {
        uuid: 'rest-user',
        nativeId: 'codex:user:entry',
        type: 'user',
        content: 'question',
        timestamp: '2026-08-17T00:00:00.000Z',
      },
      {
        uuid: 'rest-answer',
        nativeId: 'codex:item:entry-answer',
        type: 'assistant',
        content: [{ type: 'text', text: 'live answer' }],
        timestamp: '2026-08-17T00:00:01.000Z',
      },
    ],
    hasMore: false,
  });
  await loading;

  const container = h.document.querySelector('.messages');
  container.innerHTML = h.window.renderMessages(h.state.wsAllMessages, 'codex');
  h.window.rebindStrictStreamDom();

  for (const item of [
    event(sessionId, turnId, 4, 'stream_block_stop'),
    event(sessionId, turnId, 5, 'messages', {
      messages: [{
        uuid: 'live-answer',
        nativeId: 'codex:item:entry-answer',
        type: 'assistant',
        content: [{ type: 'text', text: 'live answer' }],
        timestamp: '2026-08-17T00:00:01.000Z',
      }],
    }),
    event(sessionId, turnId, 6, 'stream_end'),
  ]) {
    h.hooks.handleWsMessage(item);
  }
  await h.tick(40);

  assert.equal(container.querySelectorAll(`[data-anchor="${turnId}"]`).length, 1);
  assert.equal(container.textContent.split('live answer').length - 1, 1);
  assert.equal(
    container.querySelector(`[data-turn-id="${turnId}"]`)
      ?.classList.contains('stream-committed'),
    true,
  );
});
