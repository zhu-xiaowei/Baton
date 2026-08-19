import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

function event(sessionId, turnId, seq, action, extra = {}) {
  return { action, sessionId, turnId, seq, ...extra };
}

test('REST status releases reconnect events and settles the turn', async () => {
  const h = await makeHarness();
  const sessionId = 'codex:foreground-rest-first';
  const turnId = 'turn-foreground-rest-first';
  resetSession(h, { sessionId });

  for (const item of [
    event(sessionId, turnId, 0, 'stream_turn_start'),
    event(sessionId, turnId, 1, 'messages', {
      messages: [{
        uuid: 'user-1',
        nativeId: 'codex:user:' + turnId,
        type: 'user',
        content: 'continue',
        timestamp: '2026-08-18T13:58:40.000Z',
      }],
    }),
    event(sessionId, turnId, 2, 'stream_block_start', { kind: 'text' }),
    event(sessionId, turnId, 3, 'stream_delta', { chunk: 'partial draft' }),
  ]) h.hooks.handleWsMessage(item);
  await h.tick(20);

  h.state.ws = {
    readyState: WebSocket.OPEN,
    send() {},
  };
  let resolveRest;
  h.setApiHandler(() => new Promise((resolve) => { resolveRest = resolve; }));

  const recovery = h.hooks.beginSessionConnectionRecovery();
  h.hooks.startSessionConnectionRecovery(recovery);
  h.hooks.handleWsMessage(event(sessionId, turnId, 4, 'messages', {
    messages: [{
      uuid: 'assistant-live',
      nativeId: 'codex:item:assistant-final',
      type: 'assistant',
      content: [{ type: 'text', text: 'complete history' }],
      timestamp: '2026-08-18T13:58:44.000Z',
    }],
  }));
  h.hooks.handleWsMessage(event(sessionId, turnId, 5, 'stream_block_start', {
    kind: 'text',
  }));
  h.hooks.handleWsMessage(event(sessionId, turnId, 6, 'stream_delta', {
    chunk: 'new block after reconnect',
  }));
  await h.tick(20);

  // REST is still pending, so reconnect events remain buffered.
  assert.match(h.document.querySelector('.messages').textContent, /partial draft/);
  assert.equal(
    h.document.querySelector('.messages').textContent.includes('new block after reconnect'),
    false,
  );

  resolveRest({ messages: [], hasMore: false, status: 'completed' });
  await h.tick(40);

  // The REST snapshot and status release live events and settle the turn.
  var text = h.document.querySelector('.messages').textContent;
  assert.equal(text.includes('partial draft'), false);
  assert.equal((text.match(/complete history/g) || []).length, 1);
  assert.equal(text.includes('new block after reconnect'), false);
  assert.equal(h.state.wsRunning, false);
});
