import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

function turnEvent(sessionId, turnId, seq, action, extra = {}) {
  return { action, sessionId, turnId, seq, ...extra };
}

test('stream_end authority cannot remove an interrupt rendered by the preceding seq', async () => {
  const h = await makeHarness();
  const sessionId = 'codex:interrupt-end-authority-race';
  const turnId = 'turn-interrupted';
  resetSession(h, { sessionId });
  h.state.appState.runtime = 'codex';

  const interrupt = {
    uuid: `live_interrupt_${turnId}`,
    nativeId: `live:interrupt:${turnId}`,
    type: 'user',
    content: [{
      type: 'text',
      text: '[Request interrupted by user]',
    }],
    timestamp: '2026-08-18T10:47:00.467Z',
  };

  for (const event of [
    turnEvent(sessionId, turnId, 0, 'stream_turn_start'),
    turnEvent(sessionId, turnId, 1, 'messages', {
      messages: [{
        uuid: 'user-interrupted',
        nativeId: `codex:user:${turnId}`,
        type: 'user',
        content: 'question',
      }],
    }),
    turnEvent(sessionId, turnId, 2, 'stream_block_start', {
      kind: 'text',
    }),
    ...Array.from({ length: 13 }, (_, index) => (
      turnEvent(sessionId, turnId, index + 3, 'stream_delta', {
        chunk: String.fromCharCode(97 + index),
      })
    )),
  ]) {
    h.hooks.handleWsMessage(event);
  }

  // Captured browser arrival order: end arrives first, followed by stop and
  // authority; the missing delta closes the gap and releases seq 16..19.
  for (const event of [
    turnEvent(sessionId, turnId, 19, 'stream_end', {
      error: 'interrupted',
      messages: [interrupt],
    }),
    turnEvent(sessionId, turnId, 17, 'stream_block_stop'),
    turnEvent(sessionId, turnId, 18, 'messages', {
      messages: [interrupt],
    }),
    turnEvent(sessionId, turnId, 16, 'stream_delta', {
      chunk: 'n',
    }),
  ]) {
    h.hooks.handleWsMessage(event);
  }

  await h.tick(100);

  const turn = h.document.querySelector(`[data-turn-id="${turnId}"]`);
  assert.equal(
    turn?.querySelectorAll('.msg-interrupt').length,
    1,
    'the duplicate authority in stream_end must preserve the existing row',
  );
  assert.equal(turn?.querySelector('.msg-interrupt')?.textContent, 'Interrupted');
  assert.equal(turn?.classList.contains('stream-committed'), true);
  assert.equal(h.state.wsRunning, false);
});
