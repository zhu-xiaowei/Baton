import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

function turnEvent(sessionId, turnId, seq, action, extra = {}) {
  return { action, sessionId, turnId, seq, ...extra };
}

test('an observing window renders the interrupt inside the same active turn', async () => {
  const h = await makeHarness();
  const sessionId = 'claude:interrupt-observer';
  const turnId = 'turn-observed';
  resetSession(h, { sessionId });
  h.state.appState.runtime = 'claude';

  for (const event of [
    turnEvent(sessionId, turnId, 0, 'stream_turn_start'),
    turnEvent(sessionId, turnId, 1, 'messages', {
      messages: [{
        uuid: 'observed-user',
        type: 'user',
        content: 'observed question',
      }],
    }),
    turnEvent(sessionId, turnId, 2, 'stream_block_start', {
      kind: 'text',
    }),
    turnEvent(sessionId, turnId, 3, 'stream_delta', {
      chunk: 'observed partial answer',
    }),
    turnEvent(sessionId, turnId, 4, 'messages', {
      messages: [{
        uuid: 'observed-interrupt',
        type: 'user',
        content: [{
          type: 'text',
          text: '[Request interrupted by user]',
        }],
        timestamp: '2026-08-18T14:01:00.000Z',
      }],
    }),
  ]) {
    h.hooks.handleWsMessage(event);
  }
  await h.tick(30);

  assert.equal(h.state.wsRunning, true);
  assert.equal(
    h.document.querySelector(`[data-turn-id="${turnId}"] .msg-interrupt`)
      ?.textContent,
    'Interrupted',
  );

  h.hooks.handleWsMessage(
    turnEvent(sessionId, turnId, 5, 'stream_end', {
      messages: [{
        uuid: 'observed-interrupt',
        type: 'user',
        content: [{
          type: 'text',
          text: '[Request interrupted by user]',
        }],
        timestamp: '2026-08-18T14:01:00.000Z',
      }],
    }),
  );
  await h.tick(30);

  const anchor = h.document.querySelector(`[data-anchor="${turnId}"]`);
  const response = h.document.querySelector(`[data-turn-id="${turnId}"]`);
  assert.ok(anchor);
  assert.equal(anchor.nextElementSibling, response);
  assert.equal(response.querySelector('.msg-interrupt')?.textContent, 'Interrupted');
  assert.equal(h.state.wsRunning, false);
});
