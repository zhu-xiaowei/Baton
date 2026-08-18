import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

function event(sessionId, turnId, seq, action, extra = {}) {
  return { action, sessionId, turnId, seq, ...extra };
}

test('stream end closes a reconnected turn without waiting for turn state', async () => {
  const h = await makeHarness();
  const sessionId = 'codex:foreground-end';
  const turnId = 'turn-foreground-end';
  resetSession(h, { sessionId });

  for (const item of [
    event(sessionId, turnId, 0, 'stream_turn_start'),
    event(sessionId, turnId, 1, 'messages', {
      messages: [{
        uuid: 'user-end',
        nativeId: 'codex:user:' + turnId,
        type: 'user',
        content: 'continue',
        timestamp: '2026-08-18T15:31:19.000Z',
      }],
    }),
    event(sessionId, turnId, 2, 'stream_block_start', { kind: 'text' }),
    event(sessionId, turnId, 3, 'stream_delta', { chunk: 'before reconnect' }),
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

  for (const item of [
    event(sessionId, turnId, 24, 'stream_block_start', { kind: 'text' }),
    event(sessionId, turnId, 25, 'stream_delta', { chunk: 'complete ending' }),
    event(sessionId, turnId, 26, 'stream_block_stop'),
    event(sessionId, turnId, 27, 'messages', {
      messages: [{
        uuid: 'assistant-end',
        nativeId: 'codex:item:assistant-end',
        type: 'assistant',
        content: [{ type: 'text', text: 'complete ending' }],
        timestamp: '2026-08-18T15:31:42.000Z',
      }],
    }),
    event(sessionId, turnId, 28, 'stream_end', {
      messages: [{
        uuid: 'assistant-end',
        nativeId: 'codex:item:assistant-end',
        type: 'assistant',
        content: [{ type: 'text', text: 'complete ending' }],
        timestamp: '2026-08-18T15:31:42.000Z',
      }],
    }),
  ]) h.hooks.handleWsMessage(item);

  resolveRest({ messages: [], hasMore: false });
  await h.tick(100);

  assert.match(h.document.querySelector('.messages').textContent, /complete ending/);
  assert.equal(h.state.wsRunning, false);
});
