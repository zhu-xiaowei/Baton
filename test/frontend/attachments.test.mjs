import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createTestServer } from './helpers/vite.mjs';
import {
  attachmentPreviewText, attachmentRef, extractAttachments, fileAttachmentHtml, isTextAttachment,
  readAttachmentText, uploadAttachment,
} from '../../web/js/components/attachment.js';

const dom = new JSDOM('<!doctype html><body><div id="img-preview-row"></div>'
  + '<div id="imgOverlay"><img id="imgOverlayImg"></div><div id="content"></div>'
  + '<div id="fileOverlay"><span id="fileOverlayTitle"></span><div id="fileOverlayTabs"></div>'
  + '<button id="file-download-btn" class="file-download-action"></button><div id="file-download-status"></div>'
  + '<div id="fileOverlayBody"></div></div></body>', { url: 'https://app.test/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
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
  window.renderStagedImages();
  FakeUpload.requests = [];
  FakeUpload.statuses = [];
  globalThis.XMLHttpRequest = FakeUpload;
  window.apiPost = async () => prepared;
  window.api = async () => ({ key, name: 'deck.pptx', size: 5, previewType: 'application/octet-stream',
    url: 'https://bucket.s3.test/download', previewUrl: 'https://bucket.s3.test/preview' });
});
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  delete window.__TAURI_INTERNALS__;
  delete navigator.share;
  delete navigator.canShare;
  delete navigator.userAgent;
  window.closeFileViewer();
});
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

test('file staging retains the escaped name, icon and uppercase extension in one card', async () => {
  const name = '计划 [v2] "<img onerror=alert(1)>".pptx';
  await window.stageAttachmentFile(new File(['12345'], name));
  const entry = state.stagedImages[0];
  assert.equal(entry.uploaded, true);
  assert.equal(entry.name, name);
  const badge = document.querySelector('#img-preview-row > .staged-file .attachment-file');
  assert.equal(badge.title, name);
  assert.equal(badge.querySelector('.staged-file-name').textContent, name);
  assert.equal(badge.querySelector('.staged-file-type').textContent, 'PPTX');
  assert.ok(badge.querySelector('img').src.endsWith('/powerpoint.svg'));
  assert.equal(document.querySelector('[onerror]'), null);
  assert.equal(document.querySelector('.staged-upload-overlay[role="progressbar"]'), null);
  assert.equal(document.querySelector('.attachment-status'), null);
  assert.equal(document.querySelector('.img-remove').getAttribute('aria-label'), 'Remove ' + name);
  assert.equal(badge.disabled, false);
});

test('mixed attachments share one ordered row and preserve its scroll position', () => {
  state.stagedImages = [
    { kind: 'file', key, name: 'demo.Mp4', uploaded: true },
    { key: 'photo.jpg', uploaded: true, dataUrl: 'data:image/jpeg;base64,AA==' },
    { kind: 'file', key, name: 'README', uploaded: true },
    { kind: 'file', key, name: 'archive.', uploaded: true },
  ];
  window.renderStagedImages();
  const row = document.getElementById('img-preview-row');
  const cards = [...row.children];
  assert.deepEqual([...row.children].map(card => card.className), [
    'staged-attachment staged-file', 'staged-attachment img-thumb',
    'staged-attachment staged-file', 'staged-attachment staged-file',
  ]);
  assert.deepEqual([...row.querySelectorAll('.staged-file-type')].map(type => type.textContent), ['MP4', 'FILE', 'FILE']);
  assert.equal(row.querySelectorAll(':scope > .staged-attachment > .img-remove').length, 4);
  assert.equal(row.querySelector('.staged-files'), null);
  row.scrollLeft = 80;
  window.renderStagedImages();
  assert.equal(row.scrollLeft, 80);
  assert.deepEqual([...row.children], cards);
});

test('one SVG stays below 100% until PUT succeeds, then completes without requesting file metadata', async () => {
  globalThis.XMLHttpRequest = class extends FakeUpload {
    send(body) { this.body = body; FakeUpload.requests.push(this); }
  };
  window.api = async () => assert.fail('Successful PUT uploads must not request file metadata');
  const pending = window.stageAttachmentFile(new File(['12345'], 'demo.mp4'));
  const card = document.querySelector('.staged-file');
  const overlay = card.querySelector('[role="progressbar"]');
  assert.equal(card.querySelector('.attachment-file').disabled, true);
  assert.equal(card.querySelector('.img-remove').disabled, false);
  assert.equal(card.getAttribute('aria-busy'), 'true');
  assert.equal(overlay.dataset.state, 'preparing');
  assert.equal(overlay.getAttribute('aria-valuetext'), 'Preparing upload');
  assert.equal(overlay.hasAttribute('aria-valuenow'), false);
  const indicator = overlay.querySelector('.staged-progress-indicator');
  assert.equal(indicator.querySelectorAll('circle[fill="none"]').length, 2);
  assert.equal(indicator.querySelector('.staged-progress-ring').getAttribute('stroke-linecap'), 'round');
  await new Promise(resolve => setImmediate(resolve));
  const request = FakeUpload.requests[0];
  request.upload.onprogress({ lengthComputable: true, loaded: 42, total: 100 });
  assert.equal(document.querySelector('.staged-file'), card);
  assert.equal(document.querySelector('[role="progressbar"]'), overlay);
  assert.equal(overlay.getAttribute('aria-valuenow'), '42');
  assert.equal(overlay.querySelector('.staged-progress-pie').style.strokeDashoffset, '58');
  assert.equal(overlay.querySelector('.staged-progress-text').textContent, '42%');
  assert.equal(overlay.dataset.state, 'uploading');
  assert.equal(overlay.classList.contains('has-progress'), true);
  request.upload.onprogress({ lengthComputable: true, loaded: 100, total: 100 });
  assert.equal(overlay.dataset.state, 'uploading');
  assert.equal(overlay.classList.contains('is-waiting'), false);
  assert.equal(card.querySelector('.attachment-file').disabled, true);
  assert.equal(state.stagedImages[0].uploaded, false);
  assert.equal(overlay.getAttribute('aria-valuetext'), '99%');
  assert.equal(overlay.querySelector('.staged-progress-indicator'), indicator);
  request.status = 200;
  request.onload();
  request.onloadend();
  await pending;
  assert.equal(state.stagedImages[0].uploaded, true);
  assert.equal(overlay.querySelector('.staged-progress-text').textContent, '100%');
  assert.equal(overlay.querySelector('.staged-progress-pie').getAttribute('fill'), 'currentColor');
  assert.equal(overlay.querySelector('.staged-progress-pie').getAttribute('stroke'), 'none');
  assert.equal(overlay.querySelector('.staged-progress-pie').getAttribute('r'), '13');
  assert.equal(overlay.dataset.state, 'complete');
  assert.equal(overlay.getAttribute('aria-hidden'), 'true');
  assert.equal(overlay.hasAttribute('role'), false);
  assert.equal(document.querySelector('.attachment-file').disabled, false);
  window.renderStagedImages();
  assert.equal(document.querySelector('.staged-file'), card);
  assert.equal(document.querySelector('.staged-upload-overlay'), overlay);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(document.querySelector('.staged-upload-overlay'), null);
});

test('other attachment updates and removals preserve the running indicator and its controls', () => {
  const first = { kind: 'file', key, name: 'first.mp4', uploaded: false, progress: 35 };
  const second = { kind: 'file', key, name: 'second.mp4', uploaded: false, progress: 41 };
  state.stagedImages = [first, second];
  window.renderStagedImages();
  const card = document.getElementById('img-preview-row').children[1];
  const indicator = card.querySelector('.staged-progress-indicator');
  first.uploaded = true;
  window.renderStagedImages();
  assert.equal(card.querySelector('.staged-progress-indicator'), indicator);
  window.removeStagedImage(0);
  assert.equal(document.getElementById('img-preview-row').firstElementChild, card);
  assert.equal(card.querySelector('.staged-progress-indicator'), indicator);
  assert.equal(card.querySelector('.img-remove').getAttribute('onclick'), 'event.stopPropagation();removeStagedImage(0)');
});

test('pending images use the same mask and cannot open or enter the gallery', () => {
  const image = { key: 'photo.jpg', dataUrl: 'data:image/jpeg;base64,AA==' };
  state.stagedImages = [{ ...image, uploaded: true }, { ...image, uploaded: false }];
  document.getElementById('imgOverlay').style.display = 'none';
  window.renderStagedImages();
  const pending = document.querySelectorAll('.img-thumb')[1];
  assert.equal(pending.querySelector('.staged-image-preview').disabled, true);
  assert.equal(pending.querySelector('.staged-progress-indicator').querySelectorAll('circle[fill="none"]').length, 2);
  assert.equal(pending.querySelector('.staged-upload-overlay').dataset.state, 'loading');
  assert.equal(pending.querySelector('.staged-upload-overlay').classList.contains('has-progress'), false);
  assert.equal(pending.querySelector('.staged-progress-text').textContent, '');
  assert.equal(pending.querySelector('[role="progressbar"]').hasAttribute('aria-valuenow'), false);
  window.viewStagedImage(1);
  assert.equal(document.getElementById('imgOverlay').style.display, 'none');
  window.viewStagedImage(0);
  assert.equal(document.querySelector('.gallery-nav'), null);
});

test('image completion fades out the same ring without introducing a percentage', async () => {
  const image = { key: 'photo.jpg', dataUrl: 'data:image/jpeg;base64,AA==', uploaded: false };
  state.stagedImages = [image];
  window.renderStagedImages();
  const card = document.querySelector('.img-thumb');
  const indicator = card.querySelector('.staged-progress-indicator');
  image.uploaded = true;
  window.renderStagedImages();
  assert.equal(document.querySelector('.img-thumb'), card);
  assert.equal(card.querySelector('.staged-progress-indicator'), indicator);
  assert.equal(card.querySelector('.staged-upload-overlay').dataset.state, 'complete');
  assert.equal(card.querySelector('.staged-progress-text').textContent, '');
  assert.equal(card.querySelector('.staged-image-preview').disabled, false);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(card.querySelector('.staged-upload-overlay'), null);
});

test('failed uploads remain visible and can be retried or removed', async () => {
  FakeUpload.statuses = [500, 500];
  await window.stageAttachmentFile(new File(['12345'], 'deck.pptx'));
  assert.equal(state.stagedImages[0].uploaded, false);
  assert.ok(document.querySelector('.upload-failed'));
  assert.match(document.querySelector('.staged-error-message').textContent, /Upload failed/);
  assert.equal(document.querySelector('.staged-retry').getAttribute('onclick'), 'retryStagedFile(0)');
  assert.equal(document.querySelector('.staged-upload-overlay'), null);
  await window.retryStagedFile(0);
  assert.equal(state.stagedImages[0].uploaded, true);
  const controller = state.stagedImages[0].controller;
  window.removeStagedImage(0);
  assert.equal(controller.signal.aborted, true);
  assert.equal(state.stagedImages.length, 0);
});

test('progress remains attached to the right file after an earlier card is removed', async () => {
  globalThis.XMLHttpRequest = class extends FakeUpload {
    send(body) { this.body = body; FakeUpload.requests.push(this); }
  };
  const first = window.stageAttachmentFile(new File(['12345'], 'first.mp4'));
  const second = window.stageAttachmentFile(new File(['12345'], 'second.mp4'));
  await new Promise(resolve => setImmediate(resolve));
  window.removeStagedImage(0);
  const request = FakeUpload.requests[1];
  request.upload.onprogress({ lengthComputable: true, loaded: 60, total: 100 });
  assert.equal(document.querySelector('.staged-file-name').textContent, 'second.mp4');
  assert.equal(document.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'), '60');
  assert.equal(FakeUpload.requests[0].aborted, true);
  request.status = 200;
  request.onload();
  request.onloadend();
  await Promise.all([first, second]);
});

test('oversized files are rejected before uploading', async () => {
  await window.stageAttachmentFile({ name: 'large.pptx', size: 513 * 1024 * 1024 });
  assert.match(state.stagedImages[0].error, /512 MB/);
  assert.equal(FakeUpload.requests.length, 0);
  assert.equal(state.stagedImages[0].uploaded, false);
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
    assert.equal(attachmentPreviewText('Review ' + ref), 'Review ' + file.name);
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
  assert.equal(document.querySelector('.attachment-preview-info'), null);
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
  assert.equal(document.getElementById('fileOverlayBody').childElementCount, 0);
  resolveFile({ name: 'stale.pdf' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(document.getElementById('fileOverlay').style.display, 'none');
  assert.equal(document.getElementById('fileOverlayBody').childElementCount, 0);
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

test('the shared download button invokes the native download plugin with the original name', async () => {
  const calls = [];
  window.__TAURI_INTERNALS__ = { invoke: async (command, args) => { calls.push({ command, args }); return { status: 'saved' }; } };
  window.openFile('baton-file:' + key, 'deck.pptx');
  const downloading = window.downloadViewedFile();
  assert.equal(document.getElementById('file-download-btn').disabled, true);
  assert.equal(document.getElementById('file-download-btn').getAttribute('aria-busy'), 'true');
  assert.ok(document.querySelector('#file-download-btn .loading-spinner'));
  await downloading;
  assert.equal(calls[0].command, 'plugin:file-download|download');
  assert.equal(calls[0].args.name, 'deck.pptx');
  assert.equal(calls[0].args.url, 'https://bucket.s3.test/download');
  assert.equal(document.getElementById('file-download-status').textContent, 'Saved to Downloads.');
  assert.equal(document.getElementById('file-download-btn').disabled, false);
  assert.equal(document.getElementById('file-download-btn').classList.contains('is-downloading'), false);
});

test('mobile browser downloads attempt sharing and reuse Download when fresh activation is required', async () => {
  const shared = [];
  let attempts = 0;
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' });
  navigator.canShare = () => true;
  navigator.share = async value => {
    if (++attempts === 1) throw new DOMException('User activation expired', 'NotAllowedError');
    shared.push(value);
  };
  globalThis.fetch = async () => new Response('12345');
  window.openFile('baton-file:' + key, 'deck.pptx');
  await window.downloadViewedFile();
  assert.equal(shared.length, 0);
  assert.equal(attempts, 1);
  assert.equal(document.getElementById('file-share-btn'), null);
  assert.match(document.getElementById('file-download-status').textContent, /Tap Download again/);
  await window.downloadViewedFile();
  assert.equal(shared.length, 1);
  assert.equal(shared[0].files[0].name, 'deck.pptx');
  assert.equal(await shared[0].files[0].text(), '12345');
});

test('download errors keep the preview and restore its controls', async () => {
  window.openFile('baton-file:' + key, 'deck.pptx');
  window.api = async () => { throw new Error('Bridge offline'); };
  await window.downloadViewedFile();
  assert.match(document.getElementById('file-download-status').textContent, /Bridge offline/);
  assert.equal(document.getElementById('file-download-btn').disabled, false);
  assert.equal(document.getElementById('fileOverlay').style.display, 'flex');
});
