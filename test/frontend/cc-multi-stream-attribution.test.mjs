import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness, resetSession } from './harness.mjs';
import { replay } from './replay.mjs';

const SESSION_ID = 'claude:multi-stream-attribution';

test('watcher text is attributed by content instead of the newest Claude stream', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId: SESSION_ID });
  h.state.appState.runtime = 'claude';

  await replay(h, [
    { u: 'first question' },
    { u: 'second question' },
    { ack: 'first question', streamId: 'stream-first' },
    { ack: 'second question', streamId: 'stream-second' },
  ]);

  h.hooks.pushStreamFrame('stream-first', {
    t: 'start', seq: 0, blockId: 0, kind: 'text',
  });
  h.hooks.pushStreamFrame('stream-first', {
    t: 'delta', seq: 1, blockId: 0, chunk: 'answer for first',
  });
  h.hooks.pushStreamFrame('stream-first', {
    t: 'stop', seq: 2, blockId: 0,
  });
  h.hooks.pushStreamFrame('stream-second', {
    t: 'start', seq: 0, blockId: 0, kind: 'text',
  });
  h.hooks.pushStreamFrame('stream-second', {
    t: 'delta', seq: 1, blockId: 0, chunk: 'answer for second',
  });
  await h.tick(120);

  h.hooks.handleWsMessage({
    action: 'messages',
    sessionId: SESSION_ID,
    messages: [{
      uuid: 'watcher-first-answer',
      type: 'assistant',
      content: [{ type: 'text', text: 'answer for first' }],
      timestamp: '2026-08-12T00:00:01.000Z',
    }],
  });
  await h.tick(120);

  const rows = Array.from(h.document.querySelector('.messages').children);
  const firstQuestion = rows.findIndex((node) => node.textContent.includes('first question'));
  const secondQuestion = rows.findIndex((node) => node.textContent.includes('second question'));
  const firstAnswer = rows.findIndex((node) => node.textContent.includes('answer for first'));
  const secondPreview = h.document.getElementById('stream-turn-stream-second');

  assert.ok(firstQuestion >= 0 && firstQuestion < firstAnswer);
  assert.ok(firstAnswer < secondQuestion, 'the first answer must not move below the second question');
  assert.ok(secondPreview, 'the newer stream preview must not be cleared');
  assert.match(secondPreview.textContent, /answer for second/);
});
