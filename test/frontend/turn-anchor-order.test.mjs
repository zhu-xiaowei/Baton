import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

function turnEvent(sessionId, turnId, seq, action, extra = {}) {
  return { action, sessionId, turnId, seq, ...extra };
}

test('rapid identical turns stay attached to their own user anchors', async () => {
  const h = await makeHarness();
  const sessionId = 'codex:turn-anchor-order';
  resetSession(h, { sessionId });
  h.state.appState.runtime = 'codex';
  h.state.ws = {
    readyState: h.window.WebSocket.OPEN,
    send() {},
    close() {},
  };

  for (let index = 0; index < 4; index++) {
    h.window.doSend('same question', 'same question', []);
  }
  const turns = [...h.state.pendingSentMessages];
  const answers = turns.map((_, index) => `answer-${index + 1}`);

  // Direct acknowledgements may return in any order. They only update the
  // matching optimistic bubble and never participate in the shared seq queue.
  for (const pending of [turns[3], turns[1], turns[2], turns[0]]) {
    h.hooks.handleWsMessage({
      action: 'send_message_result',
      sessionId,
      turnId: pending.id,
      ok: true,
    });
  }

  // Entire turns may also reach this window in a different order. Each turn's
  // own queue still waits for seq=1 before releasing later render events.
  for (const index of [3, 1, 2, 0]) {
    const turnId = turns[index].id;
    const events = [
      turnEvent(sessionId, turnId, 0, 'stream_turn_start'),
      turnEvent(sessionId, turnId, 1, 'messages', {
        messages: [{
          uuid: `user-${index}`,
          type: 'user',
          content: 'same question',
          timestamp: new Date(turns[index].sentAt + 1).toISOString(),
        }],
      }),
      turnEvent(sessionId, turnId, 2, 'stream_block_start', {
        kind: 'text',
      }),
      turnEvent(sessionId, turnId, 3, 'stream_delta', {
        chunk: answers[index],
      }),
      turnEvent(sessionId, turnId, 4, 'stream_block_stop'),
      turnEvent(sessionId, turnId, 5, 'messages', {
        messages: [{
          uuid: `assistant-${index}`,
          type: 'assistant',
          content: [{ type: 'text', text: answers[index] }],
          timestamp: new Date(turns[index].sentAt + 2).toISOString(),
        }],
      }),
      turnEvent(sessionId, turnId, 6, 'stream_end'),
    ];
    for (const eventIndex of [0, 2, 3, 4, 5, 6, 1]) {
      h.hooks.handleWsMessage(events[eventIndex]);
    }
    if (index !== 0) {
      assert.equal(
        h.state.wsRunning,
        true,
        'an older completed turn cannot stop a still-outstanding send',
      );
    }
  }

  await h.tick(200);
  assert.equal(h.state.pendingSentMessages.length, 0);
  assert.equal(h.state.wsRunning, false);

  for (let index = 0; index < turns.length; index++) {
    const anchor = h.document.querySelector(
      `[data-anchor="${turns[index].id}"]`,
    );
    assert.ok(anchor);
    assert.equal(anchor.hasAttribute('data-pending'), false);
    const response = anchor.nextElementSibling;
    assert.equal(response?.dataset.turnId, turns[index].id);
    assert.equal(response.textContent, answers[index]);
    assert.equal(
      h.document.body.textContent.split(answers[index]).length - 1,
      1,
    );
  }
});
