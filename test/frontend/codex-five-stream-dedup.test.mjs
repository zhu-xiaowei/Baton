import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness, resetSession } from './harness.mjs';
import { assertTurns, replay } from './replay.mjs';

const SESSION_ID = 'codex:five-stream-dedup';
const COMPLETION_ORDER = [1, 3, 2, 5, 4];

function userMessage(index, source) {
  return {
    uuid: `${source}-user-${index}`,
    nativeId: `codex:user:stream-${index}`,
    type: 'user',
    content: `question ${index}`,
    timestamp: `2026-08-12T05:14:${String(index).padStart(2, '0')}.000Z`,
  };
}

function assistantMessage(index, source) {
  return {
    uuid: `${source}-assistant-${index}`,
    nativeId: `codex:item:answer-${index}`,
    type: 'assistant',
    content: [{ type: 'text', text: `answer ${index}` }],
    timestamp: `2026-08-12T05:15:${String(index).padStart(2, '0')}.000Z`,
  };
}

function sendMessages(h, streamId, messages) {
  h.hooks.handleWsMessage({
    action: 'messages',
    sessionId: SESSION_ID,
    streamId,
    messages,
  });
}

test('five Codex sends keep their anchors and deduplicate live/watcher races', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId: SESSION_ID });
  h.state.appState.runtime = 'codex';

  await replay(h, [
    { u: 'question 1' },
    { u: 'question 2' },
    { u: 'question 3' },
    { u: 'question 4' },
    { u: 'question 5' },
    { ack: 'question 1', streamId: 'stream-1' },
    { ack: 'question 2', streamId: 'stream-2' },
    { ack: 'question 3', streamId: 'stream-3' },
    { ack: 'question 4', streamId: 'stream-4' },
    { ack: 'question 5', streamId: 'stream-5' },
  ]);

  // The bridge may begin queued turns in a different order from the browser's
  // optimistic bubbles. Identity, not arrival order, must promote each bubble.
  for (const index of COMPLETION_ORDER) {
    const streamId = `stream-${index}`;
    sendMessages(h, streamId, [userMessage(index, 'live')]);
    sendMessages(h, streamId, [userMessage(index, 'watcher')]);

    h.hooks.pushStreamFrame(streamId, {
      t: 'start', seq: 0, blockId: 0, kind: 'text',
    });
    h.hooks.pushStreamFrame(streamId, {
      t: 'delta', seq: 1, blockId: 0, chunk: `answer ${index}`,
    });
    await h.tick(50);

    // Exercise both races seen on the real socket: watcher-first and live-first.
    const watcherFirst = index % 2 === 0;
    sendMessages(h, streamId, [
      assistantMessage(index, watcherFirst ? 'watcher' : 'live'),
    ]);
    sendMessages(h, streamId, [
      assistantMessage(index, watcherFirst ? 'live' : 'watcher'),
    ]);

    h.hooks.pushStreamFrame(streamId, {
      t: 'stop', seq: 2, blockId: 0,
    });
    h.hooks.handleStreamEnd(streamId, 3);
    await h.tick(120);
  }

  assert.deepEqual(assertTurns(h, [1, 2, 3, 4, 5].map((index) => ({
    u: `question ${index}`,
    a: `answer ${index}`,
  }))), []);

  for (const index of [1, 2, 3, 4, 5]) {
    assert.equal(h.state.wsAllMessages.filter(
      (message) => message.nativeId === `codex:user:stream-${index}`,
    ).length, 1);
    assert.equal(h.state.wsAllMessages.filter(
      (message) => message.nativeId === `codex:item:answer-${index}`,
    ).length, 1);
  }
});
