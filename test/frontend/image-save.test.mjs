import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createTestServer } from './helpers/vite.mjs';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=';
async function setup(t) {
  const dom = new JSDOM('<body><div class="messages"><div class="assistant-text"></div></div>'
    + '<div id="imgOverlay"><img id="imgOverlayImg"><button class="img-overlay-close">Close</button></div>'
    + '<textarea id="msg-input">Keep this draft</textarea></body>', {
    url: 'https://baton.test/', pretendToBeVisual: true,
  });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, location: dom.window.location,
    MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window) });
  const vite = await createTestServer({
    root: path.resolve(import.meta.dirname, '../../web'), logLevel: 'silent',
    appType: 'custom', server: { middlewareMode: true, hmr: false },
  });
  const module = await vite.ssrLoadModule('/js/components/image-save.js');
  const { state } = await vite.ssrLoadModule('/js/state.js');
  state.appState = { device: 'test-device', project: { hash: 'test-project' }, session: 'one' };
  const calls = [];
  window.__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback() {},
    invoke: async (command, args) => { calls.push({ command, args }); return { status: 'saved' }; } };
  t.after(async () => { await vite.close(); dom.window.close(); });
  return { dom, module, state, calls };
}
async function settled(button) {
  for (let i = 0; button.disabled && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(button.disabled, false);
}
function image() {
  const host = document.querySelector('.assistant-text');
  host.innerHTML = `<span class="img-placeholder" data-key="中文.png"><img src="${PNG}"></span>`;
  return host;
}

test('saving a loaded chat image preserves bytes and name, prevents duplicate clicks and retains the draft', async t => {
  const { module, calls } = await setup(t);
  const host = image();
  let opened = false;
  host.addEventListener('click', () => { opened = true; });
  module.refreshImageSaveControls();
  module.refreshImageSaveControls();
  assert.equal(host.querySelectorAll('.image-save-controls').length, 1);
  const button = host.querySelector('button');
  button.click(); button.click();
  await settled(button);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'plugin:file-download|download');
  assert.equal(calls[0].args.url, PNG);
  assert.equal(calls[0].args.name, '中文.png');
  assert.equal(opened, false);
  assert.equal(document.querySelector('#msg-input').value, 'Keep this draft');
  assert.equal(host.querySelector('[role=status]').textContent, 'Saved to Downloads.');
});

test('failures are visible and retryable; detached or wrong-session controls cannot save', async t => {
  const { module, state, calls } = await setup(t);
  const host = image();
  let fail = true;
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    calls.push({ command, args });
    if (fail) throw new Error('Disk full');
    return { status: 'cancelled' };
  };
  module.refreshImageSaveControls();
  const button = host.querySelector('button');
  button.click(); await settled(button);
  assert.equal(host.querySelector('[role=status]').textContent, 'Disk full');
  fail = false; button.click(); await settled(button);
  assert.equal(host.querySelector('[role=status]').textContent, 'Cancelled.');
  state.appState.session = 'two';
  button.click(); await settled(button);
  assert.equal(calls.length, 2);
  module.refreshImageSaveControls();
  const replacement = host.querySelector('button');
  host.remove(); replacement.click(); await settled(replacement);
  assert.equal(calls.length, 2);
});

test('fullscreen save snapshots the selected image and does not report old-image success on a new image', async t => {
  const { module, calls } = await setup(t);
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    calls.push({ command, args }); return pending;
  };
  const preview = document.querySelector('#imgOverlayImg');
  preview.src = PNG;
  module.refreshImageSaveControls();
  const button = document.querySelector('#imgOverlay .image-save-controls button');
  button.click();
  for (let i = 0; !calls.length && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls[0].args.url, PNG);
  preview.src = 'https://images.example/next.jpg';
  module.refreshImageSaveControls();
  finish({ status: 'saved' });
  await settled(button);
  assert.equal(document.querySelector('#imgOverlay [role=status]').textContent, '');
  assert.ok(document.querySelector('.img-overlay-close'));
});

test('local sources preserve bytes and reject unsafe URLs or oversized bodies; native HTTPS keeps the original URL', async t => {
  const { module } = await setup(t);
  const bytes = Buffer.from(PNG.split(',')[1], 'base64');
  const blob = new Blob([bytes], { type: 'image/png' });
  const url = URL.createObjectURL(blob);
  try {
    const file = await module.imageSaveFile(url, 'folder/原图.jpg');
    assert.deepEqual(Buffer.from(file.url.split(',')[1], 'base64'), bytes);
    assert.equal(file.name, '原图.png');
  } finally { URL.revokeObjectURL(url); }
  assert.deepEqual(await module.imageSaveFile('https://images.example/%E5%8E%9F%E5%9B%BE.png?signature=test'), {
    url: 'https://images.example/%E5%8E%9F%E5%9B%BE.png?signature=test', name: '原图.png', contentType: 'image/png',
  });
  for (const src of ['file:///private/file', 'javascript:alert(1)', 'https://user:password@images.example/x.png', 'data:text/html;base64,YQ==']) {
    await assert.rejects(module.imageSaveFile(src));
  }
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(32 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'image/png' } });
  try {
    await assert.rejects(module.imageSaveFile('blob:https://baton.test/oversized'), /32 MiB/);
    assert.equal(cancelled, true);
  } finally { globalThis.fetch = originalFetch; }
});

test('observer waits for image loading, restores controls after streamed markup updates and excludes diagrams', async t => {
  const { module } = await setup(t);
  const host = document.querySelector('.assistant-text');
  host.innerHTML = '<span class="img-placeholder" data-path="/private/image.png">Load image</span>'
    + `<div class="mermaid-block"><img src="${PNG}"></div>`;
  module.initImageSaveControls();
  assert.equal(host.querySelectorAll('.image-save-controls').length, 0);
  const placeholder = host.querySelector('.img-placeholder');
  placeholder.innerHTML = `<img src="${PNG}">`;
  for (let i = 0; !host.querySelector('.image-save-controls') && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(host.querySelectorAll('.image-save-controls').length, 1);
  host.querySelector('.image-save-controls').remove();
  for (let i = 0; !host.querySelector('.image-save-controls') && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(host.querySelectorAll('.image-save-controls').length, 1);
  assert.equal(host.querySelector('.mermaid-block .image-save-controls'), null);
});
