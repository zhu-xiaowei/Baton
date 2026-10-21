import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<div id="content"><span>Conversation</span></div>'
  + '<div id="input-bar"><div id="img-preview-row"></div><textarea id="msg-input"></textarea></div>',
{ url: 'https://app.test/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const { state } = await import('../../web/js/state.js');
await import('../../web/js/components/image.js');
const bar = document.getElementById('input-bar');
const input = document.getElementById('msg-input');
const prepared = [];

beforeEach(() => {
  window.dispatchEvent(new window.Event('blur'));
  state.stagedImages = [];
  state.appState.session = 'conversation';
  state.activeThreadCanSend = true;
  bar.style.display = 'flex';
  bar.hidden = false;
  bar.inert = false;
  input.readOnly = false;
  input.disabled = false;
  input.value = 'Unchanged draft';
  prepared.length = 0;
  window.apiPost = async (path, body) => {
    prepared.push({ path, body });
    return { key: body.contentHash.slice(0, 32), exists: true };
  };
});
after(() => dom.window.close());

function drag(type, target = document.body, files = [], extra = {}) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: ['Files'], files, ...extra },
  });
  target.dispatchEvent(event);
  return event;
}

test('dropping multiple files anywhere in the conversation reuses SHA-256 preparation without changing the draft', async () => {
  const files = [new File(['one'], 'one.txt'), new File(['two'], '中文 two.txt')];
  const event = drag('drop', document.querySelector('#content span'), files);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(state.stagedImages.map(file => file.name), ['one.txt', '中文 two.txt']);
  assert.equal(input.value, 'Unchanged draft');
  for (let i = 0; i < 100 && !state.stagedImages.every(file => file.uploaded); i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(state.stagedImages.every(file => file.uploaded));
  assert.deepEqual(prepared.map(({ path, body }) => [path, body.contentHash]).sort(),
    ['one', 'two'].map(text => ['/api/bridge/file-prepare', createHash('sha256').update(text).digest('hex')]).sort());
  assert.equal(input.value, 'Unchanged draft');
});

test('the composer hint survives child transitions and clears on exit, drop and blur', () => {
  drag('dragenter');
  drag('dragenter', input);
  const over = drag('dragover', input);
  assert.equal(over.defaultPrevented, true);
  assert.equal(over.dataTransfer.dropEffect, 'copy');
  assert.ok(bar.classList.contains('file-drop-active'));
  drag('dragleave', input);
  assert.ok(bar.classList.contains('file-drop-active'));
  drag('dragleave');
  assert.ok(!bar.classList.contains('file-drop-active'));
  drag('dragover');
  drag('drop');
  assert.ok(!bar.classList.contains('file-drop-active'));
  drag('dragover');
  window.dispatchEvent(new window.Event('blur'));
  assert.ok(!bar.classList.contains('file-drop-active'));
  const text = drag('dragover', input, [], { types: ['text/plain'] });
  assert.equal(text.defaultPrevented, false);
});

test('file drops cannot navigate the page or add attachments without a writable conversation', () => {
  const file = new File(['one'], 'one.txt');
  const blockedStates = [
    () => { state.appState.session = null; },
    () => { bar.style.display = 'none'; },
    () => { input.readOnly = true; },
    () => { state.activeThreadCanSend = false; },
  ];
  for (const block of blockedStates) {
    state.appState.session = 'conversation';
    state.activeThreadCanSend = true;
    bar.style.display = 'flex';
    input.readOnly = false;
    block();
    const over = drag('dragover');
    assert.equal(over.dataTransfer.dropEffect, 'none');
    assert.ok(!bar.classList.contains('file-drop-active'));
    assert.equal(drag('drop', document.body, [file]).defaultPrevented, true);
    assert.equal(state.stagedImages.length, 0);
  }
});

test('directory entries are skipped while regular files in the same drop are added', async () => {
  const file = new File(['one'], 'one.txt');
  drag('drop', document.body, [], { items: [
    { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }), getAsFile: () => new File([], 'folder') },
    { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }), getAsFile: () => file },
  ] });
  assert.deepEqual(state.stagedImages.map(entry => entry.name), ['one.txt']);
  for (let i = 0; i < 100 && !state.stagedImages[0].uploaded; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(state.stagedImages[0].uploaded, true);
});
