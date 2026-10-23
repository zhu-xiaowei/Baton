import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { state } from '../../web/js/state.js';
import { createDownloadManager } from '../../web/js/project/download-manager.js';
import { handleProjectFilesMessage } from '../../web/js/project/rpc.js';
import { createDownloadFeedback } from '../../web/js/project/download-feedback.js';

let dom;
test.beforeEach(() => {
  dom = new JSDOM('<body><div class="top-bar"><div id="top-right"></div></div><textarea id="draft">Keep draft</textarea></body>');
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.navigator = dom.window.navigator;
  state.SERVER = 'https://old.example'; state.KEY = 'old-key';
});
test.afterEach(() => dom.window.close());
const tick = () => new Promise(resolve => setImmediate(resolve));

test('preparation and signing use the enqueued device, project, and credentials after navigation', async () => {
  const requests = [], signs = [];
  let anchor;
  window.wsSendReliable = payload => requests.push(payload);
  window.api = async (...args) => { signs.push(args); return { url: 'https://files.example/signed', name: 'source.txt' }; };
  window.HTMLAnchorElement.prototype.click = function () { anchor = this; };
  const manager = createDownloadManager({ feedback: { show() {} } });
  const target = { name: 'source.txt', path: 'source.txt', key: 'earlier-preview', device: 'Mac', projectHash: 'original' };
  const task = manager.enqueue(target);
  target.device = 'other'; state.appState.device = 'new-device';
  assert.equal(requests[0].device, 'Mac'); assert.equal(requests[0].projectHash, 'original');
  handleProjectFilesMessage({ ...requests[0], ok: true, key: 'file-key' });
  await task.done;
  assert.equal(task.state, 'success');
  assert.equal(signs[0][0], '/api/bridge/file-url/file-key');
  assert.deepEqual(signs[0][1], { name: 'source.txt' });
  assert.equal(signs[0][2].server, 'https://old.example');
  assert.equal(signs[0][2].key, 'old-key');
  assert.equal(anchor.download, 'source.txt');
});

test('account changes reject signed results and retries without sending to the new account', async () => {
  let resolve, signs = 0, clicks = 0;
  window.api = () => { signs++; return new Promise(done => { resolve = done; }); };
  window.HTMLAnchorElement.prototype.click = () => clicks++;
  const manager = createDownloadManager();
  const task = manager.enqueue({ key: 'cached', name: 'secret.txt' });
  await tick();
  state.KEY = 'new-key';
  resolve({ url: 'https://files.example/signed', name: 'secret.txt' });
  await task.done;
  assert.equal(task.state, 'error'); assert.equal(clicks, 0);
  document.querySelector('[data-action="retry"]').click();
  await task.done;
  assert.equal(task.state, 'error'); assert.equal(signs, 1);
});

test('queued targets capture scope before execution, and preparing cancellation waits for device ack', async () => {
  const requests = [];
  window.wsSendReliable = payload => requests.push(payload);
  const manager = createDownloadManager({ feedback: { show() {} } });
  const first = manager.enqueue({ name: 'one', device: 'Mac', projectHash: 'p', path: 'one' });
  const second = manager.enqueue({ name: 'two', device: 'Mac', projectHash: 'p', path: 'two' });
  const done = manager.cancelAll();
  await tick();
  assert.equal(first.state, 'cancelling');
  assert.equal(second.state, 'cancelled');
  assert.equal(requests.length, 2);
  handleProjectFilesMessage({ ...requests[1], ok: true, status: 'cancelled' });
  await done;
  assert.equal(first.state, 'cancelled');
  assert.equal(requests.filter(r => r.operation === 'download').length, 1);
});

test('feedback escapes filenames, renders real progress, opens receipts and keeps draft on Escape', async () => {
  const opened = [];
  const feedback = createDownloadFeedback({ openReceipt: async (...args) => opened.push(args) });
  const draft = document.getElementById('draft'); draft.focus(); draft.setSelectionRange(2, 4);
  feedback.show({ id: 'x', name: '<img src=x onerror=alert(1)>', busy: true, message: 'Downloading…',
    progress: { received: 512, total: 1024 }, cancel() {} });
  assert.equal(document.querySelector('.download-name').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(document.querySelector('.download-panel img'), null);
  assert.equal(document.querySelector('progress').value, 512);
  assert.match(document.querySelector('.download-message').textContent, /50%.*512 B.*1.0 KB/);
  assert.equal(document.activeElement, draft);
  let escapedIntoChat = false;
  document.addEventListener('keydown', () => { escapedIntoChat = true; });
  draft.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(escapedIntoChat, false); assert.equal(document.querySelector('.download-panel').hidden, true);
  document.querySelector('.download-toggle').click();
  feedback.show({ id: 'x', name: 'result', message: 'Saved', result: { id: 'receipt', status: 'saved' } });
  document.querySelector('[data-action="folder"]').click(); await tick();
  assert.equal(opened[0][0].id, 'receipt'); assert.equal(opened[0][1], true);
  assert.equal(draft.value, 'Keep draft'); assert.equal(draft.selectionStart, 2);
  feedback.show({ id: 'x', name: 'result', message: 'Cancelled' });
  assert.equal(document.querySelector('[data-action="folder"]').hidden, true);
  feedback.dispose();
  assert.equal(document.querySelector('.download-panel'), null);
});
