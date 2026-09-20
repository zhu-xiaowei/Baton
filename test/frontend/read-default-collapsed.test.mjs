import assert from 'node:assert/strict';
import test from 'node:test';
import { createMessageDom } from '../../web/js/message-dom.js';
import { makeHarness, resetSession } from './harness.mjs';

const harness = await makeHarness();
await import('../../web/js/components/tool.js');
await import('../../web/js/render.js');
for (const name of ['renderToolNode', 'renderMessages', 'renderSingleMessage']) {
  globalThis[name] = harness.window[name];
}
globalThis.isToolResultOnly = harness.window.isToolResultOnly = (message) =>
  Array.isArray(message.content) && message.content.length > 0
  && message.content.every((block) => block.type === 'tool_result');
test.after(() => harness.window.close());

const toolUse = {
  uuid: 'read-use',
  type: 'assistant',
  content: [{
    type: 'tool_use', id: 'read-file', name: 'Read',
    input: { file_path: 'src/example.js' },
  }],
};
const toolResult = (text) => ({
  uuid: 'read-result',
  type: 'user',
  content: [{ type: 'tool_result', tool_use_id: 'read-file', content: text }],
});

function assertDetailsCollapsed(collapsed) {
  const node = harness.document.querySelector('[data-tool-id="read-file"]');
  assert.ok(node.querySelector('.tool-body'));
  assert.equal(node.classList.contains('tool-details-collapsed'), collapsed);
  assert.equal(node.querySelector('.tool-header').getAttribute('aria-expanded'), String(!collapsed));
  return node;
}

for (const streamed of [false, true]) {
  test(`Claude Read results default to collapsed after ${streamed ? 'streamed input' : 'a tool-use message'}`, () => {
    resetSession(harness, { sessionId: 'claude:read-collapsed' });
    harness.state.appState.runtime = 'claude';
    const turnId = `read-turn-${streamed}`;
    harness.document.querySelector('.messages').innerHTML =
      `<div class="msg-user" data-anchor="${turnId}">read the file</div>`;
    let sequence = 0;
    const dispatch = (action, extra = {}) => harness.hooks.handleWsMessage({
      action, sessionId: harness.state.wsSessionId,
      ...(streamed ? { turnId, seq: sequence++ } : {}), ...extra,
    });

    if (streamed) {
      dispatch('stream_turn_start');
      dispatch('stream_block_start', { kind: 'tool_use', name: 'Read' });
      dispatch('stream_tool_input', { chunk: JSON.stringify(toolUse.content[0].input) });
      dispatch('stream_tool_input', { chunk: ' ' });
      dispatch('stream_block_stop');
    }
    dispatch('messages', { messages: [toolUse] });
    assert.equal(harness.document.querySelector('.tool-body'), null);
    dispatch('messages', { messages: [toolResult('const value = 1;')] });
    const node = assertDetailsCollapsed(true);
    assert.match(node.textContent, /const value = 1;/);

    dispatch('messages', { messages: [toolResult('const value = 2;')] });
    const updatedNode = assertDetailsCollapsed(true);
    harness.window.toggleToolDetails(updatedNode.querySelector('.tool-header'));
    assertDetailsCollapsed(false);
    dispatch('messages', { messages: [toolResult('const value = 3;')] });
    assertDetailsCollapsed(false);
    if (streamed) {
      dispatch('stream_end', { messages: [toolUse, toolResult('const value = 3;')] });
    }
  });
}

test('Claude Read history updates use the default until details can be toggled', () => {
  resetSession(harness, { sessionId: 'claude:read-history-collapsed' });
  harness.state.appState.runtime = 'claude';
  const container = harness.document.querySelector('.messages');
  container.innerHTML = harness.window.renderMessages([toolUse], 'claude');
  assert.equal(container.querySelector('.tool-body'), null);
  const updater = createMessageDom({
    state: harness.state,
    document: harness.document,
    runtime: () => 'claude',
    renderMessages: harness.window.renderMessages,
  });
  const update = (text) => {
    harness.state.wsAllMessages = [toolUse, toolResult(text)];
    assert.equal(updater.applyChanges({ authoritative: true }), true);
  };

  update('const value = 1;');
  const node = assertDetailsCollapsed(true);
  harness.window.toggleToolDetails(node.querySelector('.tool-header'));
  update('const value = 2;');
  assertDetailsCollapsed(false);
  harness.window.toggleToolDetails(container.querySelector('.tool-header'));
  update('const value = 3;');
  assertDetailsCollapsed(true);
});
