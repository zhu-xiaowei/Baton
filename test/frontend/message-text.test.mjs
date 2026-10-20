import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { Marked } from 'marked';
import hljs from 'highlight.js';
import { StreamingDomRenderer } from '../../web/js/streaming.js';
import { messageActionTargets, messageText } from '../../web/js/message-text.js';

const dom = new JSDOM('<div class="messages"></div>', { runScripts: 'outside-only' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
dom.window.marked = new Marked();
dom.window.hljs = hljs;
dom.window.eval(fs.readFileSync(new URL('../../web/js/components/markdown.js', import.meta.url), 'utf8'));
await import('../../web/js/components/message.js');
for (const name of ['renderAssistantText', 'renderUserBubble', 'isToolResultOnly', 'isInterruptMsg']) {
  globalThis[name] = dom.window[name];
}
globalThis.renderThinking = () => '<span>private thinking</span>';
globalThis.renderToolNode = () => '<span>private tool output</span>';
await import('../../web/js/render.js');
test.after(() => dom.window.close());
const container = document.querySelector('.messages');

function render(messages) {
  container.innerHTML = window.renderMessages(messages, 'claude');
  return messageActionTargets(container);
}

test('historical source keeps Markdown, fences, quotes, tabs and CRLF without attribute injection', () => {
  const raw = '**中文** & "<tag>"\r\n```js\r\n\tconst x = \'value\';\r\n```\r\n';
  const [node] = render([{ type: 'assistant', uuid: 'one', content: raw }]);
  assert.equal(messageText(node, container), raw);
  assert.equal(container.querySelector('tag'), null);
});

test('one target per message joins separated text blocks and excludes tools, thinking and images', () => {
  const nodes = render([{ type: 'assistant', uuid: 'a', content: [
    { type: 'text', text: 'first' }, { type: 'thinking', thinking: 'secret' },
    { type: 'tool_use', id: 'tool', name: 'Read', input: {} },
    { type: 'text', text: 'second' }, { type: 'image', key: 'file.png' },
  ] }, { type: 'assistant', uuid: 'b', content: 'other message' }]);
  assert.equal(nodes.length, 2);
  assert.equal(messageText(nodes[0], container), 'first\n\nsecond');
  assert.equal(messageText(nodes[1], container), 'other message');
});

test('user source excludes attachment names, timestamps and controls; image-only offers no target', () => {
  const nodes = render([
    { type: 'user', uuid: 'u', content: '**My text**\n![](baton-bridge:a.png)' },
    { type: 'user', uuid: 'image', content: '![](baton-bridge:b.png)' },
  ]);
  nodes[0].insertAdjacentHTML('beforeend', '<button class="message-action">Copy</button>');
  assert.equal(nodes.length, 1);
  assert.equal(messageText(nodes[0], container), '**My text**');
});

test('provisional and native IDs reused across turns do not combine messages', () => {
  for (const attribute of ['data-block-id', 'data-native-id', 'data-message-id']) {
    container.innerHTML = ['one', 'two'].map(turn =>
      `<div data-turn-id="${turn}"><div class="tl-item assistant-text" ${attribute}="1" data-message-text="${turn}"></div></div>`).join('');
    const nodes = messageActionTargets(container);
    assert.equal(nodes.length, 2);
    assert.deepEqual(nodes.map(node => messageText(node, container)), ['one', 'two']);
  }
});

test('stream source contains only revealed code points and changes when history replaces the body', () => {
  const [node] = render([{ type: 'assistant', uuid: 'a', content: 'history' }]);
  const renderer = new StreamingDomRenderer({
    document, getContainer: () => container,
    renderMarkdown: (element, text) => { element.textContent = text; },
  });
  renderer.renderText({ element: node, block: { kind: 'text' }, targetText: '你🙂好', shown: 2 });
  assert.equal(messageText(node, container), '你🙂');
  node.dataset.messageText = 'authoritative replacement';
  node.innerHTML = '<p>authoritative replacement</p>';
  assert.equal(messageText(node, container), 'authoritative replacement');
});

test('unidentified messages stay separate and unknown rendered text is not guessed', () => {
  container.innerHTML = '<div class="tl-item assistant-text" data-message-text="one"></div>'
    + '<div class="tl-item assistant-text" data-message-text="two"></div>'
    + '<div class="tl-item assistant-text">unknown source</div>'
    + '<div class="summary-block"><div class="tl-item assistant-text" data-message-text="summary"></div></div>';
  const nodes = messageActionTargets(container);
  assert.equal(nodes.length, 2);
  assert.deepEqual(nodes.map(node => messageText(node, container)), ['one', 'two']);
});
