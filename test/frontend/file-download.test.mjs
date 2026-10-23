import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { downloadFile, prepareSharedFile } from '../../web/js/project/download.js';

const dom = new JSDOM('<!doctype html><body></body>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; delete navigator.canShare; delete window.__TAURI_INTERNALS__; });
test.after(() => dom.window.close());

test('browser downloads hand off the signed attachment URL without buffering its contents', async () => {
  let link;
  dom.window.HTMLAnchorElement.prototype.click = function () { link = this; };
  const file = { url: 'https://bucket.example/file?signed=1', name: '预算.xlsx' };
  assert.deepEqual(await downloadFile(file), { status: 'started' });
  assert.equal(link.href, file.url);
  assert.equal(link.download, file.name);
  assert.equal(document.querySelector('a'), null);
});

test('browser sharing rejects oversized files before allocating a blob', async () => {
  await assert.rejects(prepareSharedFile({ size: 51 * 1024 * 1024 }), /50 MB/);
});

test('browser sharing uses the media MIME type and rejects incomplete downloads', async () => {
  globalThis.fetch = async () => new Response('image');
  navigator.canShare = ({ files }) => files[0].type === 'image/png';
  const file = { url: 'https://bucket.example/photo', name: '照片.png', size: 5,
    contentType: 'application/octet-stream', previewType: 'image/png' };
  const shared = await prepareSharedFile(file);
  assert.equal(shared.name, file.name);
  assert.equal(shared.type, 'image/png');
  assert.equal(await shared.text(), 'image');
  await assert.rejects(prepareSharedFile({ ...file, size: 10 }), /incomplete/);
});

test('native cancellation waits for acknowledgement even when the transfer rejects first', async () => {
  const calls = [], progress = [];
  let rejectTransfer, confirmCancel;
  window.__TAURI_INTERNALS__ = {
    transformCallback() { return 1; },
    invoke(command, args) {
      calls.push({ command, args });
      if (command.endsWith('|cancel')) return new Promise(resolve => { confirmCancel = resolve; });
      return new Promise((_, reject) => { rejectTransfer = reject; });
    },
  };
  const controller = new AbortController();
  let settled = false;
  const pending = downloadFile({ url: 'https://files.example/signed', name: 'x' }, value => progress.push(value), { signal: controller.signal });
  const rejected = assert.rejects(pending.finally(() => { settled = true; }), { name: 'AbortError' });
  while (!calls.length) await new Promise(resolve => setImmediate(resolve));
  calls[0].args.onProgress.onmessage({ received: 10 }); assert.equal(progress.length, 1);
  controller.abort(); rejectTransfer(new Error('Download cancelled'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(calls[1].args.requestId, calls[0].args.requestId);
  calls[0].args.onProgress.onmessage({ received: 20 }); assert.equal(progress.length, 1);
  confirmCancel(); await rejected;
});

test('native cancellation failures are not reported as cancelled and completed saves are retained', async () => {
  for (const completed of [false, true]) {
    let finishTransfer;
    window.__TAURI_INTERNALS__ = {
      transformCallback() { return 1; },
      invoke(command) {
        if (command.endsWith('|cancel')) return Promise.reject(new Error('unknown command'));
        return new Promise(resolve => { finishTransfer = resolve; });
      },
    };
    const controller = new AbortController();
    const pending = downloadFile({ url: 'https://files.example/signed', name: 'x' }, null, { signal: controller.signal });
    while (!finishTransfer) await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    if (completed) {
      finishTransfer({ status: 'saved', id: 'receipt' });
      assert.equal((await pending).id, 'receipt');
    } else await assert.rejects(pending, { code: 'DOWNLOAD_CANCEL_UNCONFIRMED' });
  }
});

test('pre-aborted browser downloads never open a link', async () => {
  let clicked = false;
  dom.window.HTMLAnchorElement.prototype.click = () => { clicked = true; };
  const controller = new AbortController(); controller.abort();
  await assert.rejects(downloadFile({ url: 'https://files.example/x', name: 'x' }, null, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(clicked, false);
});
