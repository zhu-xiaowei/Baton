import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

test('seq greater than 1 waits for end and renders authority without partial preview', async () => {
  const h = await makeHarness();
  const sessionId = 'codex:late-join';
  const turnId = 'turn-late-join';
  resetSession(h, { sessionId });
  const event = (seq, action, extra = {}) => ({
    action,
    sessionId,
    turnId,
    seq,
    ...extra,
  });

  h.hooks.handleWsMessage(event(3, 'stream_delta', { chunk: 'partial' }));
  h.hooks.handleWsMessage(event(5, 'messages', {
    messages: [{
      uuid: 'assistant-late-join',
      type: 'assistant',
      content: [{ type: 'text', text: 'complete answer' }],
    }],
  }));
  assert.equal(h.document.querySelector(`[data-turn-id="${turnId}"]`), null);
  assert.equal(h.document.body.textContent.includes('partial'), false);

  h.hooks.handleWsMessage(event(6, 'stream_end', {
    messages: [{
      uuid: 'assistant-late-join',
      type: 'assistant',
      content: [{ type: 'text', text: 'complete answer' }],
    }],
  }));
  await h.tick(20);

  assert.equal(h.document.body.textContent.includes('partial'), false);
  assert.equal(
    h.document.body.textContent.split('complete answer').length - 1,
    1,
  );
});
