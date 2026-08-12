import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness, resetSession } from './harness.mjs';
import { assertTurns, replay } from './replay.mjs';

const SESSION_ID = 'codex:watcher-live-race';

function messageEnvelope(h, streamId, message) {
  h.hooks.handleWsMessage({
    action: 'messages',
    sessionId: SESSION_ID,
    ...(streamId ? { streamId } : {}),
    messages: [message],
  });
}

test('an unscoped watcher answer cannot attach to a later active stream', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId: SESSION_ID });
  h.state.appState.runtime = 'codex';

  await replay(h, [
    { u: '4' },
    { u: '5' },
    { ack: '4', streamId: 'stream-4' },
    { ack: '5', streamId: 'stream-5' },
  ]);
  messageEnvelope(h, 'stream-4', {
    uuid: 'live-user-4',
    nativeId: 'codex:user:stream-4',
    type: 'user',
    content: '4',
    timestamp: '2026-08-12T05:49:56.000Z',
  });

  h.hooks.pushStreamFrame('stream-5', {
    t: 'start', seq: 0, blockId: 0, kind: 'text',
  });
  h.hooks.pushStreamFrame('stream-5', {
    t: 'delta', seq: 1, blockId: 0, chunk: '5',
  });
  await h.tick(80);

  // The rollout watcher wins the race, but has not obtained a streamId yet.
  messageEnvelope(h, '', {
    uuid: 'watcher-answer-4',
    nativeId: 'codex:item:answer-4',
    type: 'assistant',
    content: [{ type: 'text', text: '4' }],
    timestamp: '2026-08-12T05:49:56.900Z',
  });
  // The correct live copy follows with streamId and the same native identity.
  messageEnvelope(h, 'stream-4', {
    uuid: 'live-answer-4',
    nativeId: 'codex:item:answer-4',
    type: 'assistant',
    content: [{ type: 'text', text: '4' }],
    timestamp: '2026-08-12T05:49:56.900Z',
  });
  messageEnvelope(h, 'stream-5', {
    uuid: 'live-user-5',
    nativeId: 'codex:user:stream-5',
    type: 'user',
    content: '5',
    timestamp: '2026-08-12T05:49:58.000Z',
  });
  h.hooks.pushStreamFrame('stream-5', {
    t: 'stop', seq: 2, blockId: 0,
  });
  messageEnvelope(h, 'stream-5', {
    uuid: 'live-answer-5',
    nativeId: 'codex:item:answer-5',
    type: 'assistant',
    content: [{ type: 'text', text: '5' }],
    timestamp: '2026-08-12T05:49:58.900Z',
  });
  h.hooks.handleStreamEnd('stream-5', 3);
  await h.tick(160);

  assert.deepEqual(assertTurns(h, [
    { u: '4', a: '4' },
    { u: '5', a: '5' },
  ]), []);
  assert.equal(h.state.wsAllMessages.filter(
    (message) => message.nativeId === 'codex:item:answer-4',
  ).length, 1);
});
