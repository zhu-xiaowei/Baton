import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

function event(sessionId, turnId, seq, action, extra = {}) {
  return { action, sessionId, turnId, seq, ...extra };
}

async function waitFor(h, predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await h.tick(10);
  }
  return predicate();
}

test('completed interrupt recovery discards previews absent from REST', async () => {
  const h = await makeHarness();
  const sessionId = 'claude:interrupt-recovery-preserves-preview';
  const turnId = 'sent-interrupted-recovery';
  const userId = 'interrupted-user';
  const interruptId = `live_interrupt_${turnId}`;
  resetSession(h, { sessionId });
  h.state.appState.runtime = 'claude';

  for (const item of [
    event(sessionId, turnId, 0, 'stream_turn_start'),
    event(sessionId, turnId, 1, 'messages', {
      messages: [{
        uuid: userId,
        type: 'user',
        content: 'question',
      }],
    }),
    event(sessionId, turnId, 2, 'stream_block_start', { kind: 'text' }),
    event(sessionId, turnId, 3, 'stream_delta', {
      chunk: 'visible partial answer',
    }),
    event(sessionId, turnId, 4, 'messages', {
      messages: [{
        uuid: interruptId,
        nativeId: `live:interrupt:${turnId}`,
        type: 'user',
        content: [{
          type: 'text',
          text: '[Request interrupted by user]',
        }],
        timestamp: '2026-09-01T09:55:02.102Z',
      }],
    }),
  ]) h.hooks.handleWsMessage(item);
  let partialBlock = null;
  assert.equal(await waitFor(h, () => {
    partialBlock = h.document.querySelector(
      `[data-turn-id="${turnId}"] [data-block-id="2"]`,
    );
    return partialBlock?.textContent === 'visible partial answer';
  }), true);
  assert.equal(partialBlock?.textContent, 'visible partial answer');

  h.state.ws = {
    readyState: WebSocket.OPEN,
    send() {},
  };
  let resolveRest;
  h.setApiHandler(() => new Promise((resolve) => { resolveRest = resolve; }));
  const loading = h.window.loadLatestMessages(sessionId);

  resolveRest({
    messages: [{
      uuid: userId,
      type: 'user',
      content: 'question',
    }, {
      uuid: interruptId,
      nativeId: `live:interrupt:${turnId}`,
      turnId,
      type: 'user',
      content: [{
        type: 'text',
        text: '[Request interrupted by user]',
      }],
      timestamp: '2026-09-01T09:55:02.106Z',
    }],
    hasMore: false,
    status: 'completed',
  });
  await h.tick(100);

  const turn = h.document.querySelector(`[data-turn-id="${turnId}"]`);
  assert.equal(partialBlock.isConnected, false);
  assert.equal(h.document.body.textContent.includes('visible partial answer'), false);
  assert.equal(h.document.querySelector('.stream-preview, .stream-committed'), null);
  assert.equal(turn?.querySelectorAll('.msg-interrupt').length, 1);
  assert.equal(h.state.wsRunning, false);
});
