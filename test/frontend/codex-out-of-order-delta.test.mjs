import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

const sessionId = 'codex:browser-out-of-order-delta';
const turnId = 'turn-browser-out-of-order-delta';
const chunks = [
  '清',
  '晨的阳光穿过窗帘照亮房间',
  '也',
  '唤醒新的期待\n',
  '街边的树叶随风轻响\n',
  '一杯热茶散出清香\n',
  '认真工作积累力量\n',
  '真诚交流消除误解\n',
  '保持好奇发现惊喜\n',
  '愿我们从容迎接明天',
];
const fullText = chunks.join('');

function event(seq, action, extra = {}) {
  return { action, sessionId, turnId, seq, ...extra };
}

test('browser regression: reordered Codex events append every chunk once', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId });
  h.state.appState.runtime = 'codex';

  const events = [
    event(0, 'stream_turn_start'),
    event(1, 'stream_block_start', { kind: 'text' }),
    ...chunks.map((chunk, index) =>
      event(index + 2, 'stream_delta', { chunk })),
    event(12, 'stream_block_stop'),
    event(13, 'messages', {
      messages: [{
        uuid: 'assistant-browser-out-of-order-delta',
        type: 'assistant',
        content: [{ type: 'text', text: fullText }],
      }],
    }),
    event(14, 'stream_end'),
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
  assert.ok(block);
  assert.equal(turn.classList.contains('stream-committed'), true);
  assert.equal(block.textContent, fullText);
  assert.equal(turn.textContent.split(fullText).length - 1, 1);
});
