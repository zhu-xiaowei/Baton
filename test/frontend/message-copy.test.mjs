import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { initMessageCopy, refreshMessageCopy } from '../../web/js/message-copy.js';

function setup(t) {
  const dom = new JSDOM('<div id="content"><div class="messages"></div></div><textarea id="draft">My draft</textarea>',
    { url: 'https://test/', pretendToBeVisual: true });
  for (const key of ['document', 'MutationObserver', 'navigator']) globalThis[key] = dom.window[key];
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  const writes = [];
  navigator.clipboard = { writeText: async text => writes.push(text) };
  const dispose = initMessageCopy();
  t.after(() => { dispose(); dom.window.close(); });
  const container = document.querySelector('.messages');
  const assistant = (text, id) => {
    const node = document.createElement('div');
    node.className = 'tl-item assistant-text';
    node.dataset.messageText = text;
    if (id) node.dataset.messageId = id;
    node.innerHTML = '<p>Rendered content</p>';
    container.append(node);
    return node;
  };
  return { dom, container, assistant, writes, dispose,
    tick: () => new Promise(resolve => setTimeout(resolve, 0)) };
}

test('copies the whole message once, without touching a read-only draft or dispatching input', async t => {
  const { assistant, writes, tick } = setup(t);
  assistant('**First**\n```js\nconst x = 1;\n```', 'a');
  const last = assistant('second', 'a');
  const other = assistant('other', 'b');
  const input = document.getElementById('draft');
  input.readOnly = true;
  let changed = false;
  input.addEventListener('input', () => { changed = true; });
  refreshMessageCopy();
  assert.equal(document.querySelectorAll('.message-copy').length, 2);
  last.querySelector('.message-copy').click();
  await tick();
  assert.deepEqual(writes, ['**First**\n```js\nconst x = 1;\n```\n\nsecond']);
  assert.equal(input.value, 'My draft');
  assert.equal(changed, false);
  assert.equal(other.querySelector('.message-copy').textContent, 'Copy');
});

test('clipboard failure or absence allows retry without false success', async t => {
  const { assistant, tick, writes } = setup(t);
  const node = assistant('message');
  refreshMessageCopy();
  const button = node.querySelector('.message-copy');
  navigator.clipboard.writeText = async () => { throw new Error('Denied'); };
  button.click(); await tick();
  assert.equal(button.textContent, 'Copy failed');
  navigator.clipboard = undefined;
  button.click(); await tick();
  assert.equal(button.textContent, 'Copy failed');
  navigator.clipboard = { writeText: async text => writes.push(text) };
  button.click(); await tick();
  assert.deepEqual(writes, ['message']);
  assert.equal(button.textContent, 'Copied');
});

test('pending writes capture one snapshot and cannot change a replacement conversation', async t => {
  const { assistant, container, tick } = setup(t);
  const node = assistant('old session');
  refreshMessageCopy();
  let finish;
  const values = [];
  navigator.clipboard.writeText = text => {
    values.push(text);
    return new Promise(resolve => { finish = resolve; });
  };
  const button = node.querySelector('.message-copy');
  button.click(); button.click();
  container.replaceChildren();
  assistant('new session');
  refreshMessageCopy();
  finish(); await tick();
  assert.deepEqual(values, ['old session']);
  assert.equal(document.querySelector('.message-copy').textContent, 'Copy');
});

test('identity confirmation alone regroups streaming controls without a text mutation', async t => {
  const { assistant, writes, tick } = setup(t);
  const first = assistant('one');
  const last = assistant('two');
  refreshMessageCopy();
  assert.equal(document.querySelectorAll('.message-copy').length, 2);
  first.dataset.messageId = last.dataset.messageId = 'confirmed';
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(document.querySelectorAll('.message-copy').length, 1);
  last.querySelector('.message-copy').click();
  await tick();
  assert.deepEqual(writes, ['one\n\ntwo']);
});

test('pointer press preserves composer focus and selection; inert content cannot copy', async t => {
  const { dom, assistant, writes, tick } = setup(t);
  const node = assistant('message');
  refreshMessageCopy();
  const input = document.getElementById('draft');
  input.focus(); input.setSelectionRange(1, 4);
  const event = new dom.window.Event('pointerdown', { bubbles: true, cancelable: true });
  node.querySelector('.message-copy').dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(document.activeElement, input);
  assert.equal(input.selectionStart, 1);
  node.setAttribute('inert', '');
  node.querySelector('.message-copy').click();
  await tick();
  assert.deepEqual(writes, []);
});

test('dispose removes controls and prevents late asynchronous feedback', async t => {
  const { assistant, dispose, tick } = setup(t);
  const node = assistant('message');
  refreshMessageCopy();
  let finish;
  navigator.clipboard.writeText = () => new Promise(resolve => { finish = resolve; });
  node.querySelector('.message-copy').click();
  dispose();
  finish(); await tick();
  assert.equal(document.querySelector('.message-copy'), null);
});
