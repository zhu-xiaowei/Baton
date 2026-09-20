import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness, resetSession } from './harness.mjs';

const harness = await makeHarness();
await import('../../web/js/components/tool.js');
await import('../../web/js/render.js');
for (const name of ['renderToolNode', 'renderMessages', 'renderSingleMessage']) {
  globalThis[name] = harness.window[name];
}
globalThis.renderAssistantText = (text) => text;
globalThis.isToolResultOnly = harness.window.isToolResultOnly = (message) =>
  Array.isArray(message.content) && message.content.length > 0
  && message.content.every((block) => block.type === 'tool_result');

test('collapsed tool updates do not pull the view down and visible updates follow once per frame', () => {
  resetSession(harness, { sessionId: 'codex:collapsed-scroll' });
  harness.state.appState.runtime = 'codex';
  harness.state.stickBottom = true;
  const frames = new Map();
  let frameId = 0;
  globalThis.requestAnimationFrame = harness.window.requestAnimationFrame = (callback) => {
    frames.set(++frameId, callback);
    return frameId;
  };
  globalThis.cancelAnimationFrame = harness.window.cancelAnimationFrame = (id) => frames.delete(id);
  const flushFrames = () => {
    for (let pass = 0; frames.size && pass < 100; pass++) {
      const callbacks = Array.from(frames.values());
      frames.clear();
      callbacks.forEach((callback) => callback());
    }
    assert.equal(frames.size, 0);
  };
  const content = harness.document.getElementById('content');
  const container = harness.document.querySelector('.messages');
  const turnId = 'collapsed-scroll-turn';
  container.innerHTML = `<div class="msg-user" data-anchor="${turnId}">run</div>`;
  let height = 1000;
  let top = 650;
  let heightReads = 0;
  let scrollWrites = 0;
  Object.defineProperties(content, {
    clientHeight: { configurable: true, value: 300 },
    scrollHeight: { configurable: true, get: () => { heightReads++; return height; } },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value) => { scrollWrites++; top = Math.min(value, height - 300); },
    },
  });
  let sequence = 0;
  const dispatch = (action, extra = {}) => harness.hooks.handleWsMessage({
    action, sessionId: harness.state.wsSessionId, turnId, seq: sequence++, ...extra,
  });
  const use = (id) => ({
    uuid: `${id}-use`, type: 'assistant',
    content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `echo ${id}` } }],
  });
  const result = (id, text) => ({
    uuid: `${id}-result-${text}`, type: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: text }],
  });

  dispatch('stream_turn_start');
  dispatch('stream_block_start', { kind: 'tool_use', name: 'Bash' });
  dispatch('stream_tool_input', { chunk: '{"command":"echo ' });
  dispatch('stream_tool_input', { chunk: 'one"}' });
  assert.equal(top, 650);
  assert.equal(scrollWrites, 0);
  flushFrames();
  assert.equal(top, 700);
  assert.equal(heightReads, 1);
  assert.equal(scrollWrites, 1);
  dispatch('stream_block_stop');
  dispatch('messages', { messages: [use('one')] });
  flushFrames();

  top = 650;
  heightReads = 0;
  scrollWrites = 0;
  dispatch('stream_block_start', { kind: 'tool_use', name: 'Bash' });
  dispatch('stream_tool_input', { chunk: JSON.stringify({ command: 'echo two' }) });
  dispatch('stream_tool_input', { chunk: ' ' });
  dispatch('stream_block_stop');
  dispatch('messages', { messages: [use('two')] });
  dispatch('messages', { messages: [result('two', 'hidden output')] });
  flushFrames();
  assert.equal(container.querySelector('.tool-run-group-count').textContent, '×2');
  assert.equal(container.querySelectorAll('.tool-run-group-hidden').length, 1);
  assert.match(container.querySelector('[data-tool-id="two"]').textContent, /hidden output/);
  assert.equal(top, 650);
  assert.equal(heightReads, 0);
  assert.equal(scrollWrites, 0);

  harness.window.toggleToolDetails(container.querySelector('.tool-header'));
  height = 1400;
  dispatch('messages', { messages: [result('two', 'visible output')] });
  assert.equal(top, 650);
  flushFrames();
  assert.equal(top, 1100);
  assert.equal(scrollWrites, 1);

  scrollWrites = 0;
  dispatch('messages', { messages: [result('two', 'same height')] });
  flushFrames();
  assert.equal(scrollWrites, 0);

  height = 1600;
  dispatch('messages', { messages: [result('two', 'paused before frame')] });
  harness.state.stickBottom = false;
  flushFrames();
  assert.equal(top, 1100);
  assert.equal(scrollWrites, 0);

  harness.state.stickBottom = true;
  flushFrames();
  assert.equal(top, 1100);
  dispatch('messages', { messages: [result('two', 'new content')] });
  flushFrames();
  assert.equal(top, 1300);
  assert.equal(scrollWrites, 1);

  dispatch('stream_end', { messages: [use('one'), use('two'), result('two', 'new content')] });
  flushFrames();
  harness.window.close();
});
