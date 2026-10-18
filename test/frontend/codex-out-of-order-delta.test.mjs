import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

const sessionId = 'codex:browser-out-of-order-delta';
const turnId = 'turn-browser-out-of-order-delta';
const chunks = [
  '\u6e05',
  '\u6668\u7684\u9633\u5149\u7a7f\u8fc7\u7a97\u5e18\u7167\u4eae\u623f\u95f4',
  '\u4e5f',
  '\u5524\u9192\u65b0\u7684\u671f\u5f85\n',
  '\u8857\u8fb9\u7684\u6811\u53f6\u968f\u98ce\u8f7b\u54cd\n',
  '\u4e00\u676f\u70ed\u8336\u6563\u51fa\u6e05\u9999\n',
  '\u8ba4\u771f\u5de5\u4f5c\u79ef\u7d2f\u529b\u91cf\n',
  '\u771f\u8bda\u4ea4\u6d41\u6d88\u9664\u8bef\u89e3\n',
  '\u4fdd\u6301\u597d\u5947\u53d1\u73b0\u60ca\u559c\n',
  '\u613f\u6211\u4eec\u4ece\u5bb9\u8fce\u63a5\u660e\u5929',
];
const fullText = chunks.join('');

function event(seq, action, extra = {}) {
  return { action, sessionId, turnId, seq, ...extra };
}

test('browser regression: reordered Codex events append every chunk once', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId });
  h.state.appState.runtime = 'codex';
  const userMessage = {
    uuid: 'user-browser-out-of-order-delta',
    nativeId: 'codex:user:' + turnId,
    type: 'user',
    content: 'question',
  };
  const assistantMessage = {
    uuid: 'assistant-browser-out-of-order-delta',
    nativeId: 'codex:item:browser-out-of-order-delta',
    type: 'assistant',
    content: [{ type: 'text', text: fullText }],
  };
  h.document.querySelector('.messages').innerHTML =
    `<div class="msg-user" data-anchor="${turnId}">question</div>`;

  const events = [
    event(0, 'stream_turn_start'),
    event(1, 'stream_block_start', { kind: 'text' }),
    ...chunks.map((chunk, index) =>
      event(index + 2, 'stream_delta', { chunk })),
    event(12, 'stream_block_stop'),
    event(13, 'messages', {
      messages: [assistantMessage],
    }),
    event(14, 'stream_end', {
      messages: [userMessage, assistantMessage],
    }),
  ];

  // Captured shape: a large delta overtakes the leading character, then stop,
  // authority, and end overtake the final two deltas.
  for (const index of [
    0, 1, 3, 2, 4, 5, 6, 7, 8, 9,
    12, 13, 14, 11, 10,
  ]) {
    h.hooks.handleWsMessage(events[index]);
  }

  await h.tick(100);
  const turn = h.document.querySelector(`[data-turn-id="${turnId}"]`);
  const block = turn?.querySelector('[data-block-id="1"]');
  assert.ok(turn);
  assert.equal(turn.classList.contains('stream-committed'), true);
  assert.equal((block || turn).textContent, fullText);
  assert.equal(turn.textContent.split(fullText).length - 1, 1);
});
