import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

test('seq 1 user authority resumes streaming without the payload-free start event', async () => {
  const h = await makeHarness();
  const sessionId = 'codex:seq-one';
  const turnId = 'turn-from-seq-1';
  resetSession(h, { sessionId });
  const event = (seq, action, extra = {}) => ({
    action,
    sessionId,
    turnId,
    seq,
    ...extra,
  });

  for (const item of [
    event(1, 'messages', {
      messages: [{
        uuid: 'user-from-seq-1',
        type: 'user',
        content: 'question',
      }],
    }),
    event(3, 'stream_delta', { chunk: 'answer' }),
    event(2, 'stream_block_start', { kind: 'text' }),
    event(5, 'messages', {
      messages: [{
        uuid: 'assistant-from-seq-1',
        type: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
      }],
    }),
    event(4, 'stream_block_stop'),
    event(6, 'stream_end'),
  ]) {
    h.hooks.handleWsMessage(item);
  }

  await h.tick(40);
  assert.ok(h.document.querySelector(`.msg-user[data-anchor="${turnId}"]`));
  const turn = h.document.querySelector(`[data-turn-id="${turnId}"]`);
  assert.ok(turn);
  assert.equal(turn.textContent, 'answer');
  assert.equal(turn.classList.contains('stream-committed'), true);
});
