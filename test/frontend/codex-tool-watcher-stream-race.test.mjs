import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness, resetSession } from './harness.mjs';
import { replay } from './replay.mjs';

const SESSION_ID = 'codex:tool-watcher-stream-race';
const STREAM_ID = 'stream-tool-watcher-race';

function stream(h, action, extra = {}) {
  h.hooks.handleWsMessage({
    action,
    sessionId: SESSION_ID,
    streamId: STREAM_ID,
    ...extra,
  });
}

test('an early unscoped Codex tool row hands off to one stable Ran node', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId: SESSION_ID });
  h.state.appState.runtime = 'codex';

  globalThis.renderSingleMessage = h.window.renderSingleMessage = (message) => {
    return (message.content || []).map((block) => {
      if (block.type === 'text') {
        return `<div class="tl-item assistant-text" data-ts="${message.timestamp || ''}">${block.text}</div>`;
      }
      if (block.type === 'tool_use') {
        return `<div class="tl-item tool-node" data-tool-id="${block.id}" `
          + `data-ts="${message.timestamp || ''}">Ran ${block.input.command}</div>`;
      }
      return '';
    }).join('');
  };

  await replay(h, [
    { u: 'check the API' },
    { ack: 'check the API', streamId: STREAM_ID },
  ]);

  stream(h, 'stream_block_start', {
    seq: 0, blockId: 0, kind: 'text',
  });
  stream(h, 'stream_delta', {
    seq: 1, blockId: 0, chunk: 'Checking now.',
  });
  stream(h, 'stream_block_stop', {
    seq: 2, blockId: 0,
  });
  stream(h, 'messages', {
    messages: [{
      uuid: 'live-commentary',
      type: 'assistant',
      content: [{ type: 'text', text: 'Checking now.' }],
      timestamp: '2026-08-13T06:43:17.000Z',
    }],
  });
  await h.tick(100);

  h.hooks.handleWsMessage({
    action: 'messages',
    sessionId: SESSION_ID,
    messages: [{
      uuid: 'watcher-tool',
      type: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'tool-check-api',
        name: 'Bash',
        input: { command: 'node inspect.mjs watch' },
      }],
      timestamp: '2026-08-13T06:43:18.000Z',
      stopReason: 'tool_use',
    }],
  });

  stream(h, 'stream_block_start', {
    seq: 3, blockId: 1, kind: 'tool_use', name: 'Bash',
  });
  stream(h, 'stream_tool_input', {
    seq: 4, blockId: 1, chunk: '{"command":"node inspect.mjs watch"}',
  });
  await h.tick(100);

  assert.equal(
    h.document.querySelectorAll('.tool-node').length,
    1,
    'the watcher row and stream preview must not render as duplicate tool nodes',
  );
  assert.equal(h.document.querySelector('.tool-name')?.textContent, 'Ran');
  assert.equal(h.document.querySelector('[data-tool-id="tool-check-api"]'), null);

  stream(h, 'stream_block_stop', {
    seq: 5, blockId: 1,
  });
  await h.tick(150);

  assert.equal(h.document.querySelectorAll('.tool-node').length, 1);
  assert.ok(h.document.querySelector('[data-tool-id="tool-check-api"]'));
  assert.equal(h.document.querySelector('.stream-preview'), null);
});
