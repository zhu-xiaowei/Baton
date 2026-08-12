import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness, resetSession } from './harness.mjs';
import { replay } from './replay.mjs';

const SESSION_ID = 'codex:delayed-watcher-live-race';
const STREAM_ID = 'stream-21';
const NATIVE_ID = 'codex:item:answer-21';

function messages(h, streamId, message) {
  h.hooks.handleWsMessage({
    action: 'messages',
    sessionId: SESSION_ID,
    ...(streamId ? { streamId } : {}),
    messages: [message],
  });
}

test('a delayed scoped live row supersedes its early unscoped watcher copy', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId: SESSION_ID });
  h.state.appState.runtime = 'codex';

  await replay(h, [
    { u: '21' },
    { ack: '21', streamId: STREAM_ID },
  ]);

  const answer = {
    uuid: 'watcher-answer-21',
    nativeId: NATIVE_ID,
    type: 'assistant',
    content: [{ type: 'text', text: '21' }],
    timestamp: '2026-08-12T07:35:21.426Z',
  };
  messages(h, '', answer);

  // Let the unscoped watcher row render before the exact live row arrives.
  await h.tick(200);

  messages(h, STREAM_ID, {
    ...answer,
    uuid: 'live-answer-21',
  });
  h.hooks.pushStreamFrame(STREAM_ID, {
    t: 'start', seq: 0, blockId: 0, kind: 'text',
  });
  h.hooks.pushStreamFrame(STREAM_ID, {
    t: 'delta', seq: 1, blockId: 0, chunk: '21',
  });
  h.hooks.pushStreamFrame(STREAM_ID, {
    t: 'stop', seq: 2, blockId: 0,
  });
  h.hooks.handleStreamEnd(STREAM_ID, 3);
  await h.tick(200);

  const question = Array.from(h.document.querySelectorAll('.msg-user')).find(
    (node) => (node.textContent || '').trim() === '21',
  );
  const replies = [];
  let sibling = question?.nextElementSibling;
  while (sibling && !sibling.classList.contains('msg-user')) {
    if (sibling.classList.contains('assistant-turn')) replies.push(sibling);
    sibling = sibling.nextElementSibling;
  }
  assert.equal(replies.length, 1);
  assert.equal(replies[0].textContent.trim(), '21');
  assert.equal(replies[0].classList.contains('stream-preview'), false);
});
