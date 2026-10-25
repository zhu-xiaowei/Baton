import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { downloadFile } from '../../web/js/project/download.js';

const dom = new JSDOM('<!doctype html><body></body>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
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
