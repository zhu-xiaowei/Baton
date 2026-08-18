import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

function event(sessionId, turnId, seq, action, extra = {}) {
  return { action, sessionId, turnId, seq, ...extra };
}

test('a new strict turn streams normally after REST finishes', async () => {
  const h = await makeHarness();
  const sessionId = 'codex:entry-rest-first-stream';
  const turnId = 'turn-rest-first-stream';
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

  for (const item of [
    event(sessionId, turnId, 0, 'stream_turn_start'),
    event(sessionId, turnId, 1, 'messages', {
      messages: [{
        uuid: 'strict-user',
        type: 'user',
        content: 'new question',
        timestamp: '2026-08-17T00:00:01.000Z',
      }],
    }),
    event(sessionId, turnId, 2, 'stream_block_start', { kind: 'text' }),
    event(sessionId, turnId, 3, 'stream_delta', { chunk: 'strict after REST' }),
    event(sessionId, turnId, 4, 'stream_block_stop'),
    event(sessionId, turnId, 5, 'messages', {
      messages: [{
        uuid: 'strict-answer',
        type: 'assistant',
        content: [{ type: 'text', text: 'strict after REST' }],
        timestamp: '2026-08-17T00:00:02.000Z',
      }],
    }),
    event(sessionId, turnId, 6, 'stream_end'),
  ]) {
    h.hooks.handleWsMessage(item);
  }
  await h.tick(40);

  assert.equal(container.querySelectorAll(`[data-anchor="${turnId}"]`).length, 1);
  assert.equal(
    container.textContent.split('strict after REST').length - 1,
    1,
  );
  assert.equal(
    container.querySelector(`[data-turn-id="${turnId}"]`)
      ?.classList.contains('stream-committed'),
    true,
  );
});
