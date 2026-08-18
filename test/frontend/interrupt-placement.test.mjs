import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

function turnEvent(sessionId, turnId, seq, action, extra = {}) {
  return { action, sessionId, turnId, seq, ...extra };
}

test('interrupt targets the active turn and renders before a later pending question', async () => {
  const h = await makeHarness();
  const sessionId = 'claude:interrupt-placement';
  const sent = [];
  resetSession(h, { sessionId });
  h.state.appState.runtime = 'claude';
  h.state.ws = {
    readyState: h.window.WebSocket.OPEN,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
    close() {},
  };

  h.window.doSend('question one', 'question one', []);
  const firstTurn = h.state.pendingSentMessages[0].id;
  for (const event of [
    turnEvent(sessionId, firstTurn, 0, 'stream_turn_start'),
    turnEvent(sessionId, firstTurn, 1, 'messages', {
      messages: [{
        uuid: 'user-one',
        type: 'user',
        content: 'question one',
      }],
    }),
    turnEvent(sessionId, firstTurn, 2, 'stream_block_start', {
      kind: 'text',
    }),
    turnEvent(sessionId, firstTurn, 3, 'stream_delta', {
      chunk: 'partial answer',
    }),
  ]) {
    h.hooks.handleWsMessage(event);
  }
  await h.tick(30);

  h.window.doSend('question two', 'question two', []);
  const secondTurn = h.state.pendingSentMessages.at(-1).id;
  h.window.interruptSession();

  assert.deepEqual(sent.at(-1), {
    action: 'interrupt',
    sessionId,
    device: 'D',
    turnId: firstTurn,
  });
  assert.equal(h.state.wsRunning, true);

  h.hooks.handleWsMessage(turnEvent(
    sessionId,
    firstTurn,
    4,
    'messages',
    {
      messages: [{
        uuid: 'live-interrupt-one',
        type: 'user',
        content: [{
          type: 'text',
          text: '[Request interrupted by user]',
        }],
        timestamp: '2026-08-18T14:00:00.000Z',
      }],
    },
  ));

  const firstResponse = h.document.querySelector(
    `[data-turn-id="${firstTurn}"]`,
  );
  const secondQuestion = h.document.querySelector(
    `[data-anchor="${secondTurn}"]`,
  );
  const interrupt = firstResponse?.querySelector('.msg-interrupt');

  assert.ok(interrupt);
  assert.equal(interrupt.textContent, 'Interrupted');
  assert.equal(firstResponse.nextElementSibling, secondQuestion);
  assert.equal(
    h.document.querySelectorAll('.msg-interrupt').length,
    1,
  );
  assert.equal(h.state.wsRunning, true);

  h.hooks.handleWsMessage(turnEvent(
    sessionId,
    firstTurn,
    5,
    'stream_end',
    {
      messages: [{
        uuid: 'live-interrupt-one',
        type: 'user',
        content: [{
          type: 'text',
          text: '[Request interrupted by user]',
        }],
        timestamp: '2026-08-18T14:00:00.000Z',
      }],
    },
  ));
  await h.tick(30);
  assert.equal(
    h.document.querySelectorAll('.msg-interrupt').length,
    1,
    'stream_end authority cannot duplicate the live interrupt row',
  );
  assert.equal(firstResponse.classList.contains('stream-committed'), true);
  assert.equal(
    h.state.wsRunning,
    true,
    'the later pending question keeps the shared spinner active',
  );
});
