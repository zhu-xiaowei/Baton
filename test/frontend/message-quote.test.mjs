import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { state } from '../../web/js/state.js';
import { StreamingDomRenderer } from '../../web/js/streaming.js';
import {
  initMessageQuotes, refreshMessageQuotes, messageQuoteText,
} from '../../web/js/message-quote.js';

function setup(t) {
  const dom = new JSDOM('<div class="messages"></div><div id="input-bar"><textarea id="msg-input"></textarea></div>',
    { url: 'https://test/', pretendToBeVisual: true });
  for (const name of ['window', 'document', 'Event', 'MutationObserver']) {
    globalThis[name] = name === 'window' ? dom.window : dom.window[name];
  }
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  state.SERVER = 'https://test';
  state.appState = { device: 'demo', project: { hash: 'project' }, session: 'one' };
  state.activeThreadId = null;
  state.activeThreadCanSend = true;
  const dispose = initMessageQuotes();
  t.after(() => { dispose(); dom.window.close(); });
  const container = document.querySelector('.messages');
  const input = document.getElementById('msg-input');
  let inputs = 0;
  input.addEventListener('input', () => inputs++);
  function assistant(text, id = 'a') {
    const node = document.createElement('div');
    node.className = 'tl-item assistant-text';
    node.dataset.messageId = id;
    node.dataset.messageText = text;
    node.innerHTML = '<p>Rendered content</p><button>Unrelated action</button>';
    container.append(node);
    return node;
  }
  return { container, input, assistant, inputs: () => inputs };
}

test('quote preserves Markdown and draft; duplicate click replaces it; remove only removes the quote', t => {
  const { assistant, input, inputs } = setup(t);
  const raw = '**中文**\n```js\nconst x = "<tag>";\n```';
  const node = assistant(raw);
  input.value = 'My draft';
  refreshMessageQuotes();
  node.querySelector('.message-quote').click();
  const quoted = `> Assistant:\n${raw.split('\n').map(line => '> ' + line).join('\n')}\n\nMy draft`;
  assert.equal(input.value, quoted);
  assert.equal(inputs(), 1);
  node.querySelector('.message-quote').click();
  assert.equal(input.value, quoted);
  input.value += ' plus edits';
  document.querySelector('.remove-message-quote').click();
  assert.equal(input.value, 'My draft plus edits');
  assert.equal(inputs(), 3);
});

test('one quote per assistant message includes its text blocks but no tool output or adjacent messages', t => {
  const { container, assistant, input } = setup(t);
  const first = assistant('first block');
  container.insertAdjacentHTML('beforeend', '<div class="tl-item tool-node">private tool output</div>');
  const last = assistant('second block');
  assistant('different message', 'b');
  refreshMessageQuotes();
  assert.equal(first.querySelector('.message-quote'), null);
  assert.equal(container.querySelectorAll('.message-quote').length, 2);
  last.querySelector('.message-quote').click();
  assert.equal(input.value, '> Assistant:\n> first block\n> \n> second block\n\n');
});

test('quotes user text without timestamp, attachment labels or show-more controls', t => {
  const { container, input } = setup(t);
  container.innerHTML = '<div class="msg-user"><div class="msg-attachments">file.pdf</div>'
    + '<div class="msg-text">Line one\nLine two</div><div class="msg-meta">10:20</div><span>Show more</span></div>';
  refreshMessageQuotes();
  container.querySelector('.message-quote').click();
  assert.equal(input.value, '> You:\n> Line one\n> Line two\n\n');
});

test('read-only threads, disabled composer and inert takeover prompt cannot change the draft', t => {
  const { assistant, input } = setup(t);
  const node = assistant('quote');
  refreshMessageQuotes();
  input.value = 'Keep';
  state.activeThreadCanSend = false;
  node.querySelector('.message-quote').click();
  state.activeThreadCanSend = true;
  input.disabled = true;
  node.querySelector('.message-quote').click();
  input.disabled = false;
  input.parentElement.setAttribute('inert', '');
  node.querySelector('.message-quote').click();
  assert.equal(input.value, 'Keep');
});

test('remove control is scoped by server, device, project, session and active thread', t => {
  const { assistant, input } = setup(t);
  assistant('quote');
  refreshMessageQuotes();
  input.value = 'Draft A';
  document.querySelector('.message-quote').click();
  const original = input.value;
  for (const [object, key] of [[state, 'SERVER'], [state.appState, 'device'],
    [state.appState.project, 'hash'], [state.appState, 'session'], [state, 'activeThreadId']]) {
    const previous = object[key];
    object[key] = 'different';
    refreshMessageQuotes();
    assert.equal(document.querySelector('.remove-message-quote'), null);
    object[key] = previous;
  }
  refreshMessageQuotes();
  assert.ok(document.querySelector('.remove-message-quote'));
  assert.equal(input.value, original);
  input.value = input.value.replace('> quote', '> Edited quote');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(document.querySelector('.remove-message-quote'), null);
});

test('streaming quotes only revealed text and refreshes after DOM replacement', async t => {
  const { container, assistant, input } = setup(t);
  const node = assistant('old history');
  const renderer = new StreamingDomRenderer({
    document, getContainer: () => container,
    renderMarkdown: (element, text) => { element.textContent = text; },
  });
  renderer.renderText({ element: node, block: { kind: 'text' }, targetText: '你好世界', shown: 2 });
  await new Promise(resolve => setTimeout(resolve, 55));
  node.querySelector('.message-quote').click();
  assert.equal(input.value, '> Assistant:\n> 你好\n\n');
  renderer.renderText({ element: node, block: { kind: 'text' }, targetText: '你好世界', shown: 4 });
  await new Promise(resolve => setTimeout(resolve, 55));
  assert.equal(node.querySelectorAll('.message-quote').length, 1);
  node.querySelector('.message-quote').click();
  assert.equal(input.value, '> Assistant:\n> 你好世界\n\n');
  assert.equal(messageQuoteText(node, container), '你好世界');
});

test('summary, thinking, command panels and image-only messages offer no quote', t => {
  const { container, assistant } = setup(t);
  assistant('');
  container.insertAdjacentHTML('beforeend',
    '<div class="summary-block"><div class="tl-item assistant-text" data-message-text="summary">summary</div></div>'
    + '<div class="tl-item thinking-tl">thinking</div>'
    + '<div class="tl-item command-panel-tl">command</div>');
  refreshMessageQuotes();
  assert.equal(container.querySelectorAll('.message-quote').length, 0);
});

test('provisional block IDs reused in different turns never mix their text', t => {
  const { container, input } = setup(t);
  container.innerHTML = ['one', 'two'].map(turn =>
    `<div class="assistant-turn" data-turn-id="${turn}"><div class="tl-item assistant-text" data-block-id="1" data-message-text="${turn}">${turn}</div></div>`).join('');
  refreshMessageQuotes();
  assert.equal(container.querySelectorAll('.message-quote').length, 2);
  container.querySelector('.message-quote').click();
  assert.equal(input.value, '> Assistant:\n> one\n\n');
});
