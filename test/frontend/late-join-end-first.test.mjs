import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

test('end-first late join renders authority once and ignores delayed frames', async () => {
  const h = await makeHarness();
  const sessionId = 'codex:end-first-reorder';
  const turnId = 'turn-end-first-reorder';
  resetSession(h, { sessionId });
  const event = (seq, action, extra = {}) => ({
    action,
    sessionId,
    turnId,
    seq,
    ...extra,
  });

  h.hooks.handleWsMessage(event(5, 'stream_end', {
    messages: [{
      uuid: 'end-first-answer',
      type: 'assistant',
      content: [{ type: 'text', text: 'ordered answer' }],
    }],
  }));
  await h.tick(50);

  for (const item of [
    event(0, 'stream_turn_start'),
    event(1, 'messages', {
      messages: [{
        uuid: 'end-first-user',
        type: 'user',
        content: 'question',
      }],
    }),
    event(2, 'stream_block_start', { kind: 'text' }),
    event(3, 'stream_delta', { chunk: 'ordered answer' }),
    event(4, 'stream_block_stop'),
  ]) {
    h.hooks.handleWsMessage(item);
  }
  await h.tick(20);

  const container = h.document.querySelector('.messages');
  assert.equal(
    container.textContent.split('ordered answer').length - 1,
    1,
  );
  assert.equal(container.querySelector(`[data-turn-id="${turnId}"]`), null);
  assert.equal(h.hooks.flushLateJoinCompletion(turnId), false);
});
