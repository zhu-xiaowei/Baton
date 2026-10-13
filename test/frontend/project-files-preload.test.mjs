import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
register('data:text/javascript,' + encodeURIComponent(
  'export async function load(url, context, next) {'
  + " return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context); }",
));

test('visible folders preload once and a fresh preload opens without another request', async () => {
  const dom = new JSDOM('<!DOCTYPE html><body><div id="content"></div></body>', {
    url: 'https://test/', pretendToBeVisual: true,
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.requestAnimationFrame = callback => { callback(); return 1; };
  const observers = [];
  window.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() {}
    emit() { this.callback(this.targets.map(target => ({ target, isIntersecting: true }))); }
  };
  const { state } = await import('../../web/js/state.js');
  const { handleWsRpcMessage } = await import('../../web/js/ws-rpc.js');
  const browser = await import('../../web/js/project/browser.js');
  const requests = [];
  const settle = () => new Promise(resolve => setImmediate(resolve));
  window.loadViewerLibs = async () => {};
  window.connectWs = () => {};
  window.wsSendReliable = request => requests.push(request);
  state.appState.device = 'Test device';
  state.appState.project = { hash: 'project', name: 'project' };
  function reply(request, entries = []) {
    handleWsRpcMessage({ action: 'project_files', requestId: request.requestId, ok: true, entries });
  }
  const realNow = Date.now;
  try {
    const opened = browser.openProjectFilesPath('');
    await settle();
    reply(requests[0], [
      ...['a', 'b', 'c', 'd', 'e'].map(name => ({ name, type: 'directory' })),
      { name: 'readme.md', type: 'file' },
    ]);
    await opened;
    observers.at(-1).emit();
    await settle();
    assert.deepEqual(requests.slice(1).map(request => request.path), ['a', 'b', 'c', 'd']);
    reply(requests[4], [{ name: 'd.js', type: 'file' }]);
    await settle();
    assert.equal(requests[5].path, 'e');

    // Opening a folder whose preload is still in flight joins it instead of sending again.
    const openedA = browser.openProjectFilesPath('a');
    await settle();
    assert.equal(requests.length, 6);
    reply(requests[1], [{ name: 'inner.js', type: 'file' }]);
    await openedA;
    assert.equal(document.querySelector('.project-file-name').textContent, 'inner.js');

    reply(requests[2], [{ name: 'b.js', type: 'file' }]);
    await settle();
    await browser.openProjectFilesPath('b');
    assert.equal(requests.length, 6);
    assert.equal(document.querySelector('.project-file-name').textContent, 'b.js');

    Date.now = () => realNow() + 31000;
    const stale = browser.openProjectFilesPath('a');
    await settle();
    assert.equal(requests.length, 7);
    assert.equal(requests[6].path, 'a');
    reply(requests[6], [{ name: 'inner2.js', type: 'file' }]);
    await stale;
    // The revalidation refreshed both the entries and fetchedAt in memory.
    const staleB = browser.openProjectFilesPath('b');
    await settle();
    reply(requests[7], [{ name: 'b.js', type: 'file' }]);
    await staleB;
    await browser.openProjectFilesPath('a');
    assert.equal(requests.length, 8);
    assert.equal(requests[7].path, 'b');
    assert.equal(document.querySelector('.project-file-name').textContent, 'inner2.js');
  } finally {
    Date.now = realNow;
    browser.deactivateProjectFiles(true);
    state.appState.project = null;
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.requestAnimationFrame;
  }
});

test('opening a freshly preloaded folder still persists it for the next launch', () => {
  const source = fs.readFileSync(path.join(ROOT, 'web/js/project/browser.js'), 'utf8');
  assert.match(
    source,
    /Date\.now\(\) - cached\.fetchedAt < FRESH_DIRECTORY_MS\) \{[\s\S]*?cacheDirectory\(projectHash, currentPath, cached\.entries, cached\.scrollTop\);\s*return;/,
  );
});
