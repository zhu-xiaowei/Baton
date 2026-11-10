import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createTestServer } from './helpers/vite.mjs';
import {
  attachmentPreviewText, attachmentRef, extractAttachments, fileAttachmentHtml, isTextAttachment,
  readAttachmentText, uploadAttachment,
} from '../../web/js/components/attachment.js';

const dom = new JSDOM('<!doctype html><body><div id="img-preview-row"></div>'
  + '<div id="imgOverlay"><button class="img-overlay-download" hidden></button><img id="imgOverlayImg"></div><div id="content"></div>'
  + '<div id="fileOverlay"><span id="fileOverlayTitle"></span><div id="fileOverlayTabs"></div>'
  + '<button id="file-download-btn" class="file-download-action"></button>'
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
// Uploads hash the file first, which takes a few turns of the event loop.
async function until(check) {
  for (let i = 0; i < 50 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 0));
}

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

// The SHA-256 S3 verifies, hashed in slices (same vectors as the Bridge in test/bridge/project-files.test.mjs).
test('content IDs are the SHA-256 of the whole file, hashed in slices', async () => {
  const { contentHash } = await import('../../web/js/components/content-hash.js');
  const data = new Uint8Array(9 * 1024 * 1024 + 7);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31 + (i >> 12)) & 255;
  assert.equal(await contentHash(new File([data], 'vector.bin')), 'eff34fb403f905467ac2473ee02a191f11306cae280232a7c65482449c44ac61');
  assert.equal(await contentHash(new File([], 'empty.bin')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('a file whose content is already stored completes without uploading', async () => {
  const bodies = [];
  window.apiPost = async (path, body) => { bodies.push(body); return { key: 'e'.repeat(32) + '.pdf', exists: true }; };
  await window.stageAttachmentFile(new File(['same content'], 'report.pdf'));
  assert.match(bodies[0].contentHash, /^[0-9a-f]{64}$/);
  assert.equal(FakeUpload.requests.length, 0);
  assert.equal(state.stagedImages[0].key, 'e'.repeat(32) + '.pdf');
  assert.equal(state.stagedImages[0].progress, 100);
  assert.equal(state.stagedImages[0].uploaded, true);
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
  await until(() => FakeUpload.requests.length);
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
  await until(() => FakeUpload.requests.length === 2);
  window.removeStagedImage(0);
  // Hashing finishes in either order, so find each upload by its file.
  const upload = name => FakeUpload.requests.find(item => item.body.name === name);
  const request = upload('second.mp4');
  request.upload.onprogress({ lengthComputable: true, loaded: 60, total: 100 });
  assert.equal(document.querySelector('.staged-file-name').textContent, 'second.mp4');
  assert.equal(document.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'), '60');
  assert.equal(upload('first.mp4').aborted, true);
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
  await pending;
  // Removed while hashing: neither prepared nor uploaded.
  assert.equal(finish, undefined);
  assert.equal(FakeUpload.requests.length, 0);
});

test('mixed attachments do not appear in the image gallery', () => {
  const image = { key: 'photo.jpg', uploaded: true, dataUrl: 'data:image/jpeg;base64,AA==' };
  state.stagedImages = [{ kind: 'file', key, name: 'deck.pptx', uploaded: true }, image, { ...image }];
  window.renderStagedImages();
  window.viewStagedImage(1);
  assert.equal(document.querySelector('.gallery-nav span').textContent, '1 / 2');
  document.querySelector('.gallery-nav button[data-step="1"]').click();
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

const { ooxml } = await vite.ssrLoadModule('/js/components/office-preview.js');
// Stands in for the @silurus/ooxml viewers, which load from the CDN in the app. The module is cached per
// format after the first load, so the fake reads the current test's behaviour from shared state.
const fakeViewers = { list: [], load: async () => {} };
ooxml.load = async kind => {
  const name = { docx: 'DocxScrollViewer', pptx: 'PptxScrollViewer', xlsx: 'XlsxViewer' }[kind];
  return { [name]: class {
    constructor(host, options) { Object.assign(this, { kind, host, options, destroyed: 0 }); fakeViewers.list.push(this); }
    load(url) { this.url = url; return fakeViewers.load(); }
    destroy() { this.destroyed++; }
    getScale() { return 1; }
    setScale() {}
  } };
};
function fakeOoxml(load) {
  fakeViewers.list = [];
  fakeViewers.load = load;
  return fakeViewers.list;
}

test('Word, PowerPoint and Excel open in the OOXML viewer from our own storage', async () => {
  const viewers = fakeOoxml(async () => {});
  const fetched = [];
  globalThis.fetch = async url => { fetched.push(url); return new Response('PK'); };
  for (const [ext, kind] of [['pptx', 'pptx'], ['docx', 'docx'], ['xlsx', 'xlsx']]) {
    window.openFile('baton-file:' + 'a'.repeat(32) + '.' + ext, 'file.' + ext);
    await new Promise(resolve => setTimeout(resolve, 0));
    const viewer = viewers.at(-1);
    assert.equal(viewer.kind, kind);
    assert.equal(fetched.at(-1), 'https://bucket.s3.test/preview');
    assert.equal(new TextDecoder().decode(viewer.url), 'PK');
    assert.equal(viewer.options.cjkFallback, 'sc');
    assert.equal(viewer.options.progressiveLayout, kind === 'docx' ? true : undefined);
    assert.equal(viewer.host.parentElement.id, 'fileOverlayBody');
    assert.equal(document.querySelector('#fileOverlayBody .file-loading'), null);
    window.closeFileViewer();
    assert.equal(viewer.destroyed, 1);
    assert.equal(viewer.host.isConnected, false);
  }
});

test('an Office preview closed while loading is destroyed, and over-limit files ask for a download', async () => {
  let finish;
  const viewers = fakeOoxml(() => new Promise(resolve => { finish = resolve; }));
  globalThis.fetch = async () => new Response('PK');
  window.openFile('baton-file:' + key, 'deck.pptx');
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(document.querySelector('#fileOverlayBody .loading-spinner'));
  window.closeFileViewer();
  assert.equal(viewers[0].destroyed, 1);
  finish();
  fakeOoxml(async () => { throw Object.assign(new Error('cells 250001 > 250000'), { name: 'OoxmlResourceLimitError' }); });
  window.openFile('baton-file:' + 'b'.repeat(32) + '.xlsx', 'big.xlsx');
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(document.querySelector('#fileOverlayBody .file-error').textContent,
    'This file is too large to preview. Download to open it.');
  window.closeFileViewer();
});

ooxml.loadLegacy = async format => {
  const name = format[0].toUpperCase() + format.slice(1);
  return { ['createLegacy' + name]: urls => ({ format, urls }) };
};

test('legacy Office formats open in the matching viewer through the companion reader', async () => {
  const viewers = fakeOoxml(async () => {});
  globalThis.fetch = async () => new Response('CFB');
  for (const [ext, kind, option] of [['doc', 'docx', 'legacyDoc'], ['ppt', 'pptx', 'legacyPpt'], ['xls', 'xlsx', 'legacyXls']]) {
    window.openFile('baton-file:' + 'c'.repeat(32) + '.' + ext, 'old.' + ext);
    await new Promise(resolve => setTimeout(resolve, 0));
    const viewer = viewers.at(-1);
    assert.equal(viewer.kind, kind);
    assert.equal(viewer.options[option].format, ext);
    assert.match(viewer.options[option].urls.wasmUrl, new RegExp(`ooxml-legacy-office@0\\.89\\.0/dist/legacy_${ext}_direct_bg\\.wasm$`));
    assert.match(viewer.options[option].urls.moduleUrl, new RegExp(`/dist/legacy-${ext}-source-module\\.mjs$`));
    assert.equal(viewer.options.progressiveLayout, kind === 'docx' ? true : undefined);
    window.closeFileViewer();
  }
});

test('a project PDF is uploaded through the download operation, then previewed as an attachment', async () => {
  const { handleProjectFilesMessage } = await vite.ssrLoadModule('/js/project/rpc.js');
  const pdfKey = 'b'.repeat(32) + '.pdf';
  const sent = [];
  window.wsSendReliable = payload => {
    sent.push(payload);
    queueMicrotask(() => handleProjectFilesMessage({ action: 'project_files', requestId: payload.requestId, ok: true, key: pdfKey }));
  };
  const metadata = [];
  window.api = async path => { metadata.push(path); return { name: 'spec.pdf', size: 20, previewType: 'application/pdf', previewUrl: 'https://bucket.test/spec.pdf' }; };
  try {
    window.openFile('/repo/docs/spec.pdf', 'spec.pdf @ 1a2b3c4', '', '', { projectHash: 'project' });
    assert.ok(document.querySelector('#fileOverlayBody .file-loading-content .loading-spinner'));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(sent.map(payload => [payload.operation, payload.path]), [['download', '/repo/docs/spec.pdf']]);
    assert.deepEqual(metadata, ['/api/bridge/file-url/' + pdfKey + '?name=spec.pdf']);
    assert.equal(document.querySelector('.attachment-pdf').src, 'https://bucket.test/spec.pdf');
  } finally {
    delete window.wsSendReliable;
    window.closeFileViewer();
  }
});

test('PDF previews use the same overlay and closing ignores stale responses', async () => {
  let resolveFile;
  const pdfKey = 'd'.repeat(32) + '.pdf';
  window.api = () => new Promise(resolve => { resolveFile = resolve; });
  window.openFile('baton-file:' + pdfKey, 'test.pdf');
  await new Promise(resolve => setTimeout(resolve, 0));
  resolveFile({ name: 'test.pdf', size: 20, previewType: 'application/pdf',
    url: 'https://bucket.test/download', previewUrl: 'https://bucket.test/preview' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(document.querySelector('.attachment-pdf').src, 'https://bucket.test/preview');
  window.openFile('baton-file:' + pdfKey, 'next.pdf');
  await new Promise(resolve => setTimeout(resolve, 0));
  window.closeFileViewer();
  assert.equal(document.getElementById('fileOverlayBody').childElementCount, 0);
  resolveFile({ name: 'stale.pdf' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(document.getElementById('fileOverlay').style.display, 'none');
  assert.equal(document.getElementById('fileOverlayBody').childElementCount, 0);
  assert.notEqual(document.getElementById('fileOverlayTitle').textContent, 'stale.pdf');
});

test('a cached PDF shown by the browser viewer gets a fresh URL, after a PDF.js failure or without PDF.js support', async () => {
  const pdfKey = 'e'.repeat(32) + '.pdf';
  // Just enough IndexedDB for one cache hit.
  const request = result => { const r = { result }; queueMicrotask(() => r.onsuccess()); return r; };
  const files = { get: id => request(id.endsWith(pdfKey) ? { name: 'locked.pdf', data: new Blob(['%PDF']) } : undefined), put() {} };
  globalThis.indexedDB = { open: () => request({ transaction: () => ({ objectStore: () => files }) }) };
  globalThis.fetch = async () => { throw new Error('No password given'); };
  try {
    for (const pdfJs of [true, false]) {
      if (pdfJs) Object.assign(window, { ResizeObserver: class {}, requestAnimationFrame: () => 0 });
      else delete window.ResizeObserver;
      const metadata = [];
      window.api = async path => { metadata.push(path); return { name: 'locked.pdf', size: 4, previewType: 'application/pdf', previewUrl: 'https://bucket.test/locked.pdf' }; };
      window.openFile('baton-file:' + pdfKey, 'locked.pdf');
      for (let i = 0; i < 20 && !document.querySelector('.attachment-pdf'); i++) await new Promise(resolve => setTimeout(resolve, 0));
      assert.deepEqual(metadata, ['/api/bridge/file-url/' + pdfKey + '?name=locked.pdf']);
      assert.equal(document.querySelector('.attachment-pdf').src, 'https://bucket.test/locked.pdf');
      window.closeFileViewer();
    }
  } finally {
    delete globalThis.indexedDB;
    delete window.ResizeObserver;
    delete window.requestAnimationFrame;
  }
});

test('text previews use the source viewer while Office is not decoded as text', async () => {
  assert.equal(isTextAttachment({ name: 'deck.pptx' }), false);
  assert.equal(isTextAttachment({ name: 'sheet.xlsx' }), false);
  assert.equal(isTextAttachment({ name: 'data.csv' }), true);
  window.api = async () => ({ name: 'notes.txt', size: 8, url: 'https://bucket.test/text' });
  globalThis.fetch = async () => new Response('# Notes\n');
  window.openFile('baton-file:' + 'a'.repeat(32) + '.txt', 'notes.txt');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(document.getElementById('fileOverlayBody').textContent, /# Notes/);
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
  window.__TAURI_INTERNALS__ = { transformCallback: () => 1, invoke: async (command, args) => { calls.push({ command, args }); return { status: 'saved' }; } };
  window.openFile('baton-file:' + key, 'deck.pptx');
  const downloading = window.downloadViewedFile();
  assert.equal(document.getElementById('file-download-btn').disabled, true);
  assert.equal(document.getElementById('file-download-btn').getAttribute('aria-busy'), 'true');
  assert.ok(document.querySelector('#file-download-btn .staged-progress-indicator'));
  await downloading;
  assert.equal(calls[0].command, 'plugin:file-download|download');
  assert.equal(calls[0].args.name, 'deck.pptx');
  assert.equal(calls[0].args.url, 'https://bucket.s3.test/download');
  assert.equal(document.getElementById('file-download-btn').disabled, false);
  assert.equal(document.getElementById('file-download-btn').classList.contains('is-downloading'), false);
});

for (const userAgent of ['Macintosh', 'Android']) {
  test(`${userAgent} download progress survives reopening and waits for the save result`, async () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent });
    let report;
    let finish;
    window.__TAURI_INTERNALS__ = {
      transformCallback: callback => { report = callback; return 1; },
      invoke: () => new Promise(resolve => { finish = resolve; }),
    };
    const button = document.getElementById('file-download-btn');
    const ring = () => button.querySelector('.file-download-spinner');
    window.openFile('baton-file:' + key, 'deck.pptx');
    const downloading = window.downloadViewedFile();
    await until(() => finish);
    assert.equal(ring().classList.contains('has-progress'), false);
    report({ index: 0, message: { loaded: 5, total: 10 } });
    assert.equal(ring().getAttribute('aria-valuenow'), '50');
    window.closeFileViewer();
    report({ index: 1, message: { loaded: 8, total: 10 } });
    window.openFile('baton-file:' + key, 'deck.pptx');
    assert.equal(ring().getAttribute('aria-valuenow'), '80');
    for (const [index, loaded] of [10, 12].entries()) {
      report({ index: index + 2, message: { loaded, total: 10 } });
      assert.equal(ring()?.getAttribute('aria-valuenow'), '99');
      assert.equal(button.getAttribute('aria-busy'), 'true');
      assert.equal(button.disabled, true);
    }
    finish({ status: 'saved' });
    await downloading;
    assert.equal(button.classList.contains('is-downloading'), false);
    assert.equal(button.disabled, false);
    assert.equal(button.querySelector('path').getAttribute('d'), 'M5 12.5l4.5 4.5L19 7.5');
  });
}

test('iOS download completion shows a check before the share sheet closes', async () => {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' });
  let report;
  let finishSharing;
  let calls = 0;
  window.__TAURI_INTERNALS__ = {
    transformCallback: callback => { report = callback; return 1; },
    invoke: () => { calls++; return new Promise(resolve => { finishSharing = resolve; }); },
  };
  window.openFile('baton-file:' + key, 'deck.pptx');
  const downloading = window.downloadViewedFile();
  await until(() => finishSharing);
  const button = document.getElementById('file-download-btn');
  report({ index: 0, message: { loaded: 5, total: 10 } });
  assert.equal(button.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'), '50');
  // The completion event must replace the last reported progress immediately,
  // even though the native invoke stays pending until the user dismisses the share sheet.
  report({ index: 1, message: { loaded: 10, total: 10 } });
  assert.equal(button.querySelector('[role="progressbar"]'), null);
  assert.equal(button.querySelector('path').getAttribute('d'), 'M5 12.5l4.5 4.5L19 7.5');
  assert.equal(button.getAttribute('aria-busy'), 'false');
  assert.equal(button.disabled, true);
  await window.downloadViewedFile();
  assert.equal(calls, 1);
  finishSharing({ status: 'shared' });
  await downloading;
  assert.equal(button.disabled, false);
});

test('closing the viewer cancels an iOS native download', async () => {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' });
  const calls = [];
  let finish;
  window.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: command => {
      calls.push(command);
      if (command.endsWith('|cancel')) { finish({ status: 'cancelled' }); return Promise.resolve(); }
      return new Promise(resolve => { finish = resolve; });
    },
  };
  window.openFile('baton-file:' + key, 'deck.pptx');
  const downloading = window.downloadViewedFile();
  for (let i = 0; i < 20 && !finish; i++) await new Promise(resolve => setTimeout(resolve, 0));
  window.closeFileViewer();
  await downloading;
  assert.deepEqual(calls, ['plugin:file-download|download', 'plugin:file-download|cancel']);
  window.openFile('baton-file:' + key, 'deck.pptx');
  assert.equal(document.getElementById('file-download-btn').classList.contains('is-downloading'), false);
});

test('download errors keep the preview and restore its controls', async () => {
  window.openFile('baton-file:' + key, 'deck.pptx');
  window.api = async () => { throw new Error('Bridge offline'); };
  await window.downloadViewedFile();
  assert.equal(document.getElementById('file-download-btn').disabled, false);
  assert.equal(document.getElementById('fileOverlay').style.display, 'flex');
});

test('the image viewer downloads the current stored image through the native plugin', async () => {
  const { showImageViewer } = await import('../../web/js/components/image-viewer.js');
  const calls = [];
  const requested = [];
  window.__TAURI_INTERNALS__ = { transformCallback: () => 1, invoke: async (command, args) => { calls.push({ command, args }); return { status: 'saved' }; } };
  window.api = async (path, params) => { requested.push({ path, params }); return { url: 'https://bucket.test/photo' }; };
  showImageViewer([{ src: 'blob:https://app.test/2', key: 'b'.repeat(32) + '.png', attachment: true }]);
  document.querySelector('.img-overlay-download').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(requested, [{ path: '/api/bridge/image-url/' + 'b'.repeat(32) + '.png', params: { attachment: 'true' } }]);
  assert.equal(calls[0].command, 'plugin:file-download|download');
  assert.deepEqual([calls[0].args.url, calls[0].args.name, calls[0].args.mime],
    ['https://bucket.test/photo', 'b'.repeat(32) + '.png', 'image/png']);
  delete window.__TAURI_INTERNALS__;
});

test('the image viewer tracks each image download: switching back keeps it busy, closing on iOS cancels the rest', async () => {
  const { showImageViewer, closeImageViewer } = await import('../../web/js/components/image-viewer.js');
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' });
  const calls = [];
  const pending = [];
  window.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: command => {
      calls.push(command.split('|')[1]);
      // Like the iOS plugin: one download at a time, cancelled by a new download or `cancel`.
      pending.splice(0).forEach(resolve => resolve({ status: 'cancelled' }));
      return command.endsWith('|cancel') ? Promise.resolve() : new Promise(resolve => pending.push(resolve));
    },
  };
  window.api = async () => ({ url: 'https://bucket.test/photo' });
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  const button = document.querySelector('.img-overlay-download');
  const step = direction => document.querySelector(`.gallery-nav [data-step="${direction}"]`).click();
  showImageViewer([{ src: 'blob:e', key: 'e'.repeat(32) + '.png' }, { src: 'blob:f', key: 'f'.repeat(32) + '.png' }]);
  button.click();
  await settle();
  step(1);
  step(-1);
  assert.equal(button.classList.contains('is-downloading'), true);
  assert.equal(button.disabled, true);
  step(1);
  button.click();
  await settle();
  closeImageViewer();
  await settle();
  assert.deepEqual(calls, ['download', 'download', 'cancel']);
});
