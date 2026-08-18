import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

function event(sessionId, turnId, seq, action, extra = {}) {
  return { action, sessionId, turnId, seq, ...extra };
}

test('foreground recovery never revives the most recently completed turn', async () => {
  const h = await makeHarness();
  const sessionId = 'codex:foreground-completed-turn';
  resetSession(h, { sessionId });
  h.state.appState.runtime = 'codex';
  h.state.ws = {
    readyState: WebSocket.OPEN,
    send() {},
  };

  h.window.doSend('first turn', 'first turn', []);
  const firstTurnId = h.state.pendingSentMessages[0].id;
  const firstUser = {
    uuid: 'first-user',
    nativeId: 'codex:user:' + firstTurnId,
    type: 'user',
    content: 'first turn',
    timestamp: '2026-08-18T15:30:00.000Z',
  };
  const firstAnswer = {
    uuid: 'first-answer',
    nativeId: 'codex:item:first-answer',
    type: 'assistant',
    content: [{ type: 'text', text: 'first answer' }],
    timestamp: '2026-08-18T15:30:01.000Z',
  };
  for (const item of [
    event(sessionId, firstTurnId, 0, 'stream_turn_start'),
    event(sessionId, firstTurnId, 1, 'messages', { messages: [firstUser] }),
    event(sessionId, firstTurnId, 2, 'stream_block_start', { kind: 'text' }),
    event(sessionId, firstTurnId, 3, 'stream_delta', { chunk: 'first answer' }),
    event(sessionId, firstTurnId, 4, 'stream_block_stop'),
    event(sessionId, firstTurnId, 5, 'messages', { messages: [firstAnswer] }),
    event(sessionId, firstTurnId, 6, 'stream_end', {
      messages: [firstUser, firstAnswer],
    }),
  ]) h.hooks.handleWsMessage(item);
  await h.tick(80);

  assert.equal(h.state.pendingSentMessages.length, 0);
  assert.equal(h.state.wsRunning, false);

  const recovery = h.hooks.beginSessionConnectionRecovery();
  assert.deepEqual(recovery.turnIds, []);
  h.setApiResponse({ messages: [], hasMore: false, needSync: false });
  h.hooks.startSessionConnectionRecovery(recovery);
  await h.tick(30);

  h.window.doSend('second turn', 'second turn', []);
  const secondTurnId = h.state.pendingSentMessages[0].id;
  const secondUser = {
    uuid: 'second-user',
    nativeId: 'codex:user:' + secondTurnId,
    type: 'user',
    content: 'second turn',
    timestamp: '2026-08-18T15:30:02.000Z',
  };
  const secondAnswer = {
    uuid: 'second-answer',
    nativeId: 'codex:item:second-answer',
    type: 'assistant',
    content: [{ type: 'text', text: 'second answer' }],
    timestamp: '2026-08-18T15:30:03.000Z',
  };
  for (const item of [
    event(sessionId, secondTurnId, 0, 'stream_turn_start'),
    event(sessionId, secondTurnId, 1, 'messages', { messages: [secondUser] }),
    event(sessionId, secondTurnId, 2, 'stream_block_start', { kind: 'text' }),
    event(sessionId, secondTurnId, 3, 'stream_delta', { chunk: 'second answer' }),
    event(sessionId, secondTurnId, 4, 'stream_block_stop'),
    event(sessionId, secondTurnId, 5, 'messages', { messages: [secondAnswer] }),
    event(sessionId, secondTurnId, 6, 'stream_end', {
      messages: [secondUser, secondAnswer],
    }),
  ]) h.hooks.handleWsMessage(item);
  await h.tick(80);

  assert.equal(h.state.pendingSentMessages.length, 0);
  assert.equal(h.state.wsRunning, false);
});
