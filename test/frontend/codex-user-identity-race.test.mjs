import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness, resetSession } from './harness.mjs';
import { replay } from './replay.mjs';

const SESSION_ID = 'codex:user-identity-race';
const STREAM_ID = 'stream-46';

function messages(h, streamId, message) {
  h.hooks.handleWsMessage({
    action: 'messages',
    sessionId: SESSION_ID,
    streamId,
    messages: [message],
  });
}

test('turn-id and client-id user echoes promote one stream anchor only once', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId: SESSION_ID });
  h.state.appState.runtime = 'codex';

  await replay(h, [
    { u: '46' },
    { ack: '46', streamId: STREAM_ID },
  ]);

  messages(h, STREAM_ID, {
    uuid: 'watcher-user-46',
    nativeId: 'codex:turn:turn-46:user',
    type: 'user',
    content: '46',
    timestamp: '2026-08-12T07:53:01.291Z',
  });
  messages(h, STREAM_ID, {
    uuid: 'live-user-46',
    nativeId: `codex:user:${STREAM_ID}`,
    type: 'user',
    content: '46',
    timestamp: '2026-08-12T07:53:01.293Z',
  });
  await h.tick(20);

  const users = Array.from(h.document.querySelectorAll('.msg-user'))
    .filter((node) => (node.textContent || '').trim() === '46');
  assert.equal(users.length, 1);
  assert.ok(users[0].dataset.anchor);
  assert.equal(users[0].hasAttribute('data-pending'), false);
});
