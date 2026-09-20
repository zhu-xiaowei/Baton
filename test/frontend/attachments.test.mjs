import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createTestServer } from './helpers/vite.mjs';
import {
  attachmentRef, extractAttachments, fileAttachmentHtml, isTextAttachment,
  readAttachmentText, uploadAttachment,
} from '../../web/js/components/attachment.js';

const dom = new JSDOM('<!doctype html><body><div id="img-preview-row"></div>'
  + '<div id="imgOverlay"><img id="imgOverlayImg"></div><div id="content"></div>'
  + '<div id="fileOverlay"><span id="fileOverlayTitle"></span><div id="fileOverlayTabs"></div>'
  + '<div id="fileOverlayBody"></div></div></body>', { url: 'https://app.test/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
const originalFetch = globalThis.fetch;
const key = 'a'.repeat(32) + '.pptx';
const prepared = {
  key, url: 'https://bucket.s3-accelerate.test/file', fallbackUrl: 'https://bucket.s3.test/file',
  headers: { 'Content-Type': 'application/octet-stream', 'x-amz-meta-filename': 'deck.pptx' },
};
const { state } = await import('../../web/js/state.js');
await import('../../web/js/components/image.js');
await import('../../web/js/components/message.js');
const vite = await createTestServer({
  root: new URL('../../web', import.meta.url).pathname, configFile: false,
  server: { middlewareMode: true }, appType: 'custom',
});
await vite.ssrLoadModule('/js/project/file-viewer.js');

class FakeUpload {
  static requests = [];
  static statuses = [];
  constructor() { this.upload = {}; this.headers = {}; }
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(name, value) { this.headers[name] = value; }
  send(body) {
    this.body = body;
    FakeUpload.requests.push(this);
    queueMicrotask(() => {
      this.status = FakeUpload.statuses.shift() ?? 200;
      this.upload.onprogress?.({ lengthComputable: true, loaded: body.size, total: body.size });
      this.onload();
      this.onloadend();
    });
  }
  abort() { this.aborted = true; this.onloadend?.(); }
}

test.beforeEach(() => {
  state.stagedImages = [];
  FakeUpload.requests = [];
  FakeUpload.statuses = [];
  globalThis.XMLHttpRequest = FakeUpload;
  window.apiPost = async () => prepared;
  window.api = async () => ({ key, name: 'deck.pptx', size: 5, previewType: 'application/octet-stream',
    url: 'https://bucket.s3.test/download', previewUrl: 'https://bucket.s3.test/preview' });
});
test.afterEach(() => { globalThis.fetch = originalFetch; window.closeFileViewer(); });
test.after(async () => { await vite.close(); dom.window.close(); });

test('raw files use direct PUT with progress and standard-S3 fallback', async () => {
  const file = new File(['slides'], 'deck.pptx');
  FakeUpload.statuses = [503, 200];
  const progress = [];
  await uploadAttachment(file, prepared, value => progress.push(value), new AbortController().signal);
  assert.deepEqual(FakeUpload.requests.map(request => request.url), [prepared.url, prepared.fallbackUrl]);
  for (const request of FakeUpload.requests) {
    assert.equal(request.body, file);
    assert.equal(request.method, 'PUT');
    assert.equal(request.headers['x-api-key'], undefined);
    assert.deepEqual(request.headers, prepared.headers);
  }
  assert.deepEqual(progress, [100, 100]);
});

test('cancelled uploads do not retry or send content', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(uploadAttachment(new File(['test'], 'test.txt'), prepared,
    () => {}, controller.signal), { name: 'AbortError' });
  assert.equal(FakeUpload.requests.length, 0);
});

test('file staging retains name and shows a compact second-row icon', async () => {
  const name = '计划 [v2] "<img onerror=alert(1)>".pptx';
  await window.stageAttachmentFile(new File(['12345'], name));
  const entry = state.stagedImages[0];
  assert.equal(entry.uploaded, true);
  assert.equal(entry.name, name);
  const badge = document.querySelector('.staged-files .attachment-file');
  assert.equal(badge.title, name);
  assert.equal(badge.querySelector('.file-badge-name').textContent, name);
  assert.ok(badge.querySelector('img').src.endsWith('/powerpoint.svg'));
  assert.equal(document.querySelector('[onerror]'), null);
  assert.equal(document.querySelector('.attachment-status').textContent, '');
});

test('failed uploads remain visible and can be retried or removed', async () => {
  FakeUpload.statuses = [500, 500];
  await window.stageAttachmentFile(new File(['12345'], 'deck.pptx'));
  assert.equal(state.stagedImages[0].uploaded, false);
  assert.ok(document.querySelector('.upload-failed'));
  await window.retryStagedFile(0);
  assert.equal(state.stagedImages[0].uploaded, true);
  const controller = state.stagedImages[0].controller;
  window.removeStagedImage(0);
  assert.equal(controller.signal.aborted, true);
  assert.equal(state.stagedImages.length, 0);
});

test('oversized files and unconfirmed uploads are not marked ready', async () => {
  await window.stageAttachmentFile({ name: 'large.pptx', size: 513 * 1024 * 1024 });
  assert.match(state.stagedImages[0].error, /512 MB/);
  assert.equal(FakeUpload.requests.length, 0);
  await window.stageAttachmentFile(new File(['wrong-size'], 'deck.pptx'));
  assert.equal(state.stagedImages[1].uploaded, false);
  assert.match(state.stagedImages[1].error, /does not match/);
});

test('removal during preparation prevents starting an upload', async () => {
  let finish;
  window.apiPost = () => new Promise(resolve => { finish = resolve; });
  const pending = window.stageAttachmentFile(new File(['12345'], 'deck.pptx'));
  window.removeStagedImage(0);
  finish(prepared);
  await pending;
  assert.equal(FakeUpload.requests.length, 0);
});

test('mixed attachments do not appear in the image gallery', () => {
  const image = { key: 'photo.jpg', uploaded: true, dataUrl: 'data:image/jpeg;base64,AA==' };
  state.stagedImages = [{ kind: 'file', key, name: 'deck.pptx', uploaded: true }, image, { ...image }];
  window.renderStagedImages();
  window.viewStagedImage(1);
  assert.equal(document.querySelector('.gallery-nav span').textContent, '1 / 2');
  window.galleryNext();
  assert.equal(document.querySelector('.gallery-nav span').textContent, '2 / 2');
});

test('live and historical user bubbles show the original filename without markup injection', () => {
  const file = { key, name: '中文 [v2] "<bad>".pptx' };
  const refs = [attachmentRef(file), attachmentRef(file).replace('baton-file:' + key,
    '<C:\\Users\\demo\\.baton-bridge\\attachments\\' + key + '>')];
  for (const ref of refs) {
    const container = document.createElement('div');
    container.innerHTML = window.renderUserBubble({ type: 'user', content: 'Review ' + ref });
    assert.equal(container.querySelector('.file-badge-name').textContent, file.name);
    assert.equal(container.querySelector('.msg-text').textContent, 'Review');
    assert.ok(container.querySelector('img').src.endsWith('/powerpoint.svg'));
    assert.equal(container.querySelector('bad'), null);
  }
  assert.equal(fileAttachmentHtml({ key: 'bad" onclick="oops', name: 'bad' }), '');
  assert.equal(extractAttachments('[%](baton-file:' + key + ')').files.length, 0);
});

test('Office uses the existing preview overlay without sharing files with a third party', async () => {
  window.openFile('baton-file:' + key, 'deck.pptx');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(document.getElementById('fileOverlay').style.display, 'flex');
  assert.equal(document.getElementById('fileOverlayTitle').textContent, 'deck.pptx');
  assert.match(document.getElementById('fileOverlayBody').textContent, /No inline preview/);
  assert.equal(document.querySelector('.attachment-preview-info a.ext-link').href, 'https://bucket.s3.test/download');
  assert.equal(document.querySelector('iframe'), null);
});

test('PDF previews use the same overlay and closing ignores stale responses', async () => {
  let resolveFile;
  window.api = () => new Promise(resolve => { resolveFile = resolve; });
  window.openFile('baton-file:' + key, 'test.pdf');
  resolveFile({ name: 'test.pdf', size: 20, previewType: 'application/pdf',
    url: 'https://bucket.test/download', previewUrl: 'https://bucket.test/preview' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(document.querySelector('.attachment-pdf').src, 'https://bucket.test/preview');
  window.openFile('baton-file:' + key, 'next.pdf');
  window.closeFileViewer();
  resolveFile({ name: 'stale.pdf' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(document.getElementById('fileOverlay').style.display, 'none');
  assert.notEqual(document.getElementById('fileOverlayTitle').textContent, 'stale.pdf');
});

test('text previews use the source viewer while Office is not decoded as text', async () => {
  assert.equal(isTextAttachment({ name: 'deck.pptx' }), false);
  assert.equal(isTextAttachment({ name: 'sheet.xlsx' }), false);
  assert.equal(isTextAttachment({ name: 'data.csv' }), true);
  window.api = async () => ({ name: 'notes.md', size: 8, url: 'https://bucket.test/text' });
  globalThis.fetch = async () => new Response('# Notes\n');
  window.openFile('baton-file:' + key, 'notes.md');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(document.getElementById('fileOverlayBody').textContent, /# Notes/);
  assert.equal(document.getElementById('fileOverlayTabs').style.display, '');
});

test('text preview cancels at its limit instead of buffering an entire large file', async () => {
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('0123456789')); },
    cancel() { cancelled = true; },
  }));
  assert.deepEqual(await readAttachmentText('https://bucket.test/large', 5), { text: '01234', truncated: true });
  assert.equal(cancelled, true);
});
