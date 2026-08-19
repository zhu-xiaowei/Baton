import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

const h = await makeHarness();

test('bottom following re-pins after the next layout frame', async () => {
  resetSession(h, { sessionId: 'codex:scroll-follow' });
  const content = h.document.getElementById('content');
  let height = 640;
  Object.defineProperty(content, 'scrollHeight', {
    configurable: true,
    get: () => height,
  });

  h.state.stickBottom = true;
  content.scrollTop = 0;
  assert.equal(h.hooks.pinContentToBottom(), true);
  assert.equal(content.scrollTop, 640);

  height = 920;
  await h.tick(10);
  assert.equal(content.scrollTop, 920);

  h.state.stickBottom = false;
  content.scrollTop = 240;
  height = 1200;
  assert.equal(h.hooks.pinContentToBottom(), false);
  await h.tick(10);
  assert.equal(content.scrollTop, 240);
});

test('an OUT update on an earlier tool still keeps the whole view at the bottom', async () => {
  resetSession(h, { sessionId: 'codex:out-follow' });
  const content = h.document.getElementById('content');
  const container = h.document.querySelector('.messages');
  let height = 700;
  Object.defineProperty(content, 'scrollHeight', {
    configurable: true,
    get: () => height,
  });

  globalThis.isToolResultOnly = h.window.isToolResultOnly = (message) =>
    Array.isArray(message.content)
    && message.content.length > 0
    && message.content.every((block) => block.type === 'tool_result');
  globalThis.renderToolNode = h.window.renderToolNode = () => {
    height = 980;
    return '<div class="tool-header">completed output</div>';
  };

  container.innerHTML = [
    '<div class="assistant-turn">',
    '<div class="tl-item tool-node" data-tool-id="tool-1"></div>',
    '</div>',
    '<div class="msg-user">later content</div>',
  ].join('');
  const toolUse = {
    uuid: 'assistant-tool',
    type: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'tool-1',
      name: 'Bash',
      input: { command: 'pwd' },
    }],
  };
  const toolResult = {
    uuid: 'tool-result',
    type: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'tool-1',
      content: 'done',
    }],
  };
  h.state.wsAllMessages = [toolUse, toolResult];
  h.state.wsRenderedCount = 1;
  h.state.stickBottom = true;
  content.scrollTop = 400;

  h.hooks.updateLastTurn([toolResult]);
  assert.equal(
    container.querySelector('[data-tool-id="tool-1"]').textContent,
    'completed output',
  );
  assert.equal(content.scrollTop, 980);

  height = 1040;
  await h.tick(10);
  assert.equal(content.scrollTop, 1040);
});
