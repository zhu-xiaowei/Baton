import assert from 'node:assert/strict';
import test from 'node:test';
import { createMessageDom } from '../../web/js/message-dom.js';
import { refreshThinkingGroups } from '../../web/js/thinking.js';
import { makeHarness, resetSession } from './harness.mjs';

const harness = await makeHarness();
await import('../../web/js/components/message.js');
await import('../../web/js/render.js');
for (const name of ['renderThinking', 'renderUserBubble', 'renderMessages', 'renderSingleMessage', 'isToolResultOnly']) {
  globalThis[name] = harness.window[name];
}
globalThis.renderAssistantText = (text) => text;
test.after(() => harness.window.close());

const thinking = (text = '', duration) => ({
  type: 'thinking', thinking: text,
  ...(duration == null ? {} : { duration_ms: duration }),
});
const assistant = (uuid, content) => ({ uuid, type: 'assistant', content });

test('Claude live empty thinking starts a timer, merges consecutive rows, and freezes at completion', async () => {
  resetSession(harness, { sessionId: 'claude:thinking' });
  harness.state.appState.runtime = 'claude';
  const turnId = 'thinking-turn';
  const container = harness.document.querySelector('.messages');
  container.innerHTML = `<div class="msg-user" data-anchor="${turnId}">question</div>`;
  let sequence = 0;
  const dispatch = (action, extra = {}) => harness.hooks.handleWsMessage({
    action, sessionId: harness.state.wsSessionId, turnId, seq: sequence++, ...extra,
  });
  dispatch('stream_turn_start');
  try {
    dispatch('stream_block_start', { kind: 'thinking' });
    const first = container.querySelector('.thinking-tl');
    assert.ok(first);
    assert.equal(first.querySelector('.thinking-label').textContent, 'Thinking 0s');
    await harness.tick(1100);
    assert.match(first.querySelector('.thinking-label').textContent, /^Thinking [1-9]\d*s$/);
    dispatch('stream_block_stop');
    dispatch('stream_block_start', { kind: 'thinking' });
    assert.equal(container.querySelectorAll('.thinking-tl:not(.thinking-group-hidden)').length, 1);
    assert.match(first.querySelector('.thinking-label').textContent, /^Thinking [1-9]\d*s$/);
    dispatch('stream_block_stop');
    dispatch('messages', {
      messages: [assistant('thinking-authority', [thinking(), thinking()])],
    });
  } finally {
    dispatch('stream_end', {
      messages: [assistant('thinking-authority', [thinking(), thinking()])],
    });
  }
  assert.equal(container.querySelectorAll('.thinking-tl:not(.thinking-group-hidden)').length, 1);
  assert.match(container.querySelector('.thinking-label').textContent, /^Thought for [1-9]\d*s$/);
  assert.equal(container.querySelector('[data-thinking-started-at]'), null);
});

test('thinking history merges only adjacent empty rows and sums known durations', () => {
  resetSession(harness);
  const container = harness.document.querySelector('.messages');
  container.innerHTML = harness.window.renderMessages([
    assistant('one', [thinking('', 2000)]),
    assistant('two', [thinking(' ', 3000)]),
    assistant('three', [{ type: 'text', text: 'answer' }, thinking()]),
    { uuid: 'user', type: 'user', content: 'next question' },
    assistant('four', [thinking(), thinking('visible reasoning'), thinking()]),
  ], 'claude');
  refreshThinkingGroups(container);
  const rows = Array.from(container.querySelectorAll('.thinking-tl'));
  assert.equal(rows.length, 6);
  assert.equal(container.querySelectorAll('.thinking-group-hidden').length, 1);
  assert.equal(rows[0].querySelector('.thinking-label').textContent, 'Thought for 5s');
  assert.equal(rows[1].classList.contains('thinking-group-hidden'), true);
  assert.equal(rows[4].classList.contains('thinking-empty'), false);
  assert.equal(rows[4].querySelector('.thinking-body').textContent, 'visible reasoning');
  assert.equal(rows[0].querySelector('.thinking-block').dataset.thinkingDurationMs, '2000');
  refreshThinkingGroups(container);
  assert.equal(rows[0].querySelector('.thinking-label').textContent, 'Thought for 5s');
});

test('thinking groups span adjacent assistant turns but not tools', () => {
  const container = harness.document.querySelector('.messages');
  const row = () => `<div class="tl-item thinking-tl">${harness.window.renderThinking(thinking())}</div>`;
  container.innerHTML = `<div class="assistant-turn">${row()}</div>`
    + `<div class="assistant-turn">${row()}<div class="tool-node">Read</div>${row()}</div>`;
  refreshThinkingGroups(container);
  assert.equal(container.querySelectorAll('.thinking-group-hidden').length, 1);
  assert.equal(container.querySelectorAll('.thinking-tl:not(.thinking-group-hidden)').length, 2);
});

test('history reconciliation retains measured thinking duration unless authority supplies one', () => {
  resetSession(harness);
  const container = harness.document.querySelector('.messages');
  const message = assistant('measured', [thinking()]);
  container.innerHTML = harness.window.renderMessages([message], 'claude');
  container.querySelector('.thinking-block').dataset.thinkingDurationMs = '2500';
  const updater = createMessageDom({
    state: harness.state,
    document: harness.document,
    runtime: () => 'claude',
    renderMessages: harness.window.renderMessages,
    markTurnAdjacency: refreshThinkingGroups,
  });
  harness.state.wsAllMessages = [message];
  updater.applyChanges({ authoritative: true });
  updater.finalize();
  assert.equal(container.querySelector('.thinking-label').textContent, 'Thought for 3s');
  harness.state.wsAllMessages = [assistant('measured', [thinking('', 6000)])];
  updater.applyChanges({ authoritative: true });
  updater.finalize();
  assert.equal(container.querySelector('.thinking-label').textContent, 'Thought for 6s');
});
