import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { downloadFile, prepareSharedFile } from '../../web/js/project/download.js';

const dom = new JSDOM('<!doctype html><body></body>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; delete navigator.canShare; });
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
