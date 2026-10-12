import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(import.meta.dirname, '../..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');

test('New Project only collects a directory path', () => {
  const dom = new JSDOM(indexHtml);
  const modal = dom.window.document.getElementById('newProjectModal');

  assert.ok(modal);
  assert.equal(modal.querySelector('.modal-title').textContent, 'Project folder');
  assert.equal(modal.querySelector('.modal-desc'), null);
  assert.equal(modal.querySelector('#newProjectHint'), null);
  assert.equal(modal.querySelector('#newProjectAsAgent'), null);
  assert.equal(modal.textContent.includes('Claude Agents Run in background'), false);
  assert.ok(modal.querySelector('#newProjectInput'));
});

test('directory picker navigates, previews creation, pages, and ignores obsolete responses', async () => {
  const dom = new JSDOM(indexHtml, { url: 'https://test/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const { state } = await import('../../web/js/state.js');
  const { handleWsRpcMessage } = await import('../../web/js/ws-rpc.js');
  const picker = await import('../../web/js/project/directory-picker.js');
  const requests = [];
  window.loadViewerLibs = async () => {};
  window.wsSendReliable = request => requests.push(request);
  state.appState.device = 'Test device';
  const settle = () => new Promise(resolve => setImmediate(resolve));
  function reply(request, extra = {}) {
    handleWsRpcMessage({
      action: 'project_files', requestId: request.requestId, ok: true,
      path: '/home/test', targetPath: '/home/test', parentPath: '/home',
      exists: true, entries: [{ name: 'asset', type: 'directory' }], ...extra,
    });
  }
  const input = document.getElementById('newProjectInput');
  const list = document.getElementById('newProjectDirectories');
  const create = document.querySelector('#newProjectModal .confirm');
  try {
    const initial = picker.browseNewProjectPath('');
    await settle();
    assert.equal(requests[0].device, 'Test device');
    assert.equal(requests[0].operation, 'browse');
    assert.equal(requests[0].projectHash, undefined);
    reply(requests[0]);
    await initial;
    assert.equal(input.value, '/home/test');
    assert.equal(input.selectionStart, input.value.length);
    assert.equal(input.selectionEnd, input.value.length);
    assert.equal(create.disabled, false);
    state._pendingCreatePath = '/pending';
    await picker.browseNewProjectPath('/while-creating');
    assert.equal(requests.length, 1);
    state._pendingCreatePath = null;
    list.querySelector('button').click();
    assert.equal(input.value, '/home/test/asset');
    assert.equal(input.selectionStart, input.value.length);
    assert.equal(input.selectionEnd, input.value.length);
    assert.equal(create.disabled, true);
    await settle();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].path, '/home/test/asset');
    reply(requests[1], {
      path: '/home/test/asset', targetPath: '/home/test/asset', parentPath: '/home/test',
      entries: [],
    });
    await settle();
    const parent = picker.newProjectParentDirectory();
    assert.equal(input.value, '/home/test');
    assert.equal(create.disabled, false);
    assert.equal(requests.length, 2);
    await parent;

    const preview = picker.browseNewProjectPath('/home/test/new');
    await settle();
    reply(requests[2], { targetPath: '/home/test/new', parentPath: '/home/test', exists: false });
    await preview;
    assert.equal(list.textContent, 'Will create this folder');

    const old = picker.browseNewProjectPath('/old');
    await settle();
    const latest = picker.browseNewProjectPath('/latest');
    await settle();
    reply(requests[4], { path: '/latest', targetPath: '/latest', nextCursor: '200', entries: [{ name: '<safe>' }] });
    await settle();
    assert.equal(requests[5].cursor, '200');
    reply(requests[5], { path: '/latest', targetPath: '/latest', entries: [{ name: 'last' }] });
    await latest;
    reply(requests[3], { path: '/old', targetPath: '/old' });
    await old;
    assert.equal(input.value, '/latest');
    assert.equal(list.querySelectorAll('button').length, 2);
    assert.equal(list.querySelector('.project-file-name').textContent, '<safe>');

    const closed = picker.browseNewProjectPath('/closed');
    await settle();
    picker.closeNewProjectDirectoryPicker();
    reply(requests[6], { path: '/closed', targetPath: '/closed' });
    await closed;
    assert.equal(input.value, '/closed');

    const unsupported = picker.browseNewProjectPath('');
    await settle();
    handleWsRpcMessage({
      action: 'project_files', requestId: requests[7].requestId,
      ok: false, error: 'project not found',
    });
    await unsupported;
    assert.match(document.getElementById('newProjectError').textContent, /Update this device’s Bridge/);
    assert.equal(list.hasAttribute('aria-busy'), false);
    assert.equal(create.disabled, true);
  } finally {
    picker.closeNewProjectDirectoryPicker();
    state._pendingCreatePath = null;
    state.appState.device = null;
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
  }
});

test('directory input filters prefixes while keeping ordinary folders ahead of hidden folders', async () => {
  const dom = new JSDOM(indexHtml, { url: 'https://test/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const { state } = await import('../../web/js/state.js');
  const { handleWsRpcMessage } = await import('../../web/js/ws-rpc.js');
  const picker = await import('../../web/js/project/directory-picker.js');
  const requests = [];
  const names = ['.hidden', 'zebra', 'aws', 'auto', 'account-dev', 'asset', '.agents'];
  window.loadViewerLibs = async () => {};
  window.wsSendReliable = request => {
    requests.push(request);
    const directory = request.path === '/home/test/asset' ? '/home/test/asset' : '/home/test';
    queueMicrotask(() => handleWsRpcMessage({
      action: 'project_files', requestId: request.requestId, ok: true,
      path: directory, targetPath: directory, parentPath: directory.endsWith('/asset') ? '/home/test' : '/home', exists: true,
      entries: (directory.endsWith('/asset') ? ['child'] : names).map(name => ({ name, type: 'directory' })),
    }));
  };
  const input = document.getElementById('newProjectInput');
  const visibleNames = () => [...document.querySelectorAll('#newProjectDirectories .project-file-name')]
    .map(node => node.textContent);
  try {
    await picker.browseNewProjectPath('');
    assert.deepEqual(visibleNames(), ['account-dev', 'asset', 'auto', 'aws', 'zebra', '.agents', '.hidden']);
    input.value = '/home/test/a';
    input.setSelectionRange(3, 3);
    picker.onNewProjectPathInput();
    assert.deepEqual(visibleNames(), ['account-dev', 'asset', 'auto', 'aws']);
    assert.equal(input.selectionStart, 3);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(requests.length, 1);
    assert.equal(input.value, '/home/test/a');
    assert.deepEqual(visibleNames(), ['account-dev', 'asset', 'auto', 'aws']);

    await picker.browseNewProjectPath('/home/test/A', true);
    assert.deepEqual(visibleNames(), ['account-dev', 'asset', 'auto', 'aws']);
    await picker.browseNewProjectPath('/home/test/.', true);
    assert.deepEqual(visibleNames(), ['.agents', '.hidden']);
    await picker.browseNewProjectPath('/home/test/new-folder', true);
    assert.deepEqual(visibleNames(), []);
    assert.equal(document.getElementById('newProjectDirectories').textContent, 'Will create this folder');

    await picker.browseNewProjectPath('/home/test/asset', true);
    assert.deepEqual(visibleNames(), ['asset']);
    await picker.browseNewProjectPath('/home/test/asset');
    assert.deepEqual(visibleNames(), ['child']);
    assert.equal(requests.length, 2);
    await picker.newProjectParentDirectory();
    assert.equal(requests.length, 2);
    await picker.browseNewProjectPath('/home/test/asset');
    assert.equal(requests.length, 2);

    const originalDevice = state.appState.device;
    state.appState.device = 'Other device';
    await picker.browseNewProjectPath('/home/test');
    assert.equal(requests.length, 3);
    state.appState.device = originalDevice;
    picker.closeNewProjectDirectoryPicker();
    await picker.browseNewProjectPath('');
    assert.equal(requests.length, 4);
  } finally {
    picker.closeNewProjectDirectoryPicker();
    state._pendingCreatePath = null;
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
  }
});

test('visible folder preloads are bounded, skip offscreen work, and share foreground requests', async () => {
  const dom = new JSDOM(indexHtml, { url: 'https://test/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const observers = [];
  window.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
    emit(entries) { this.callback(entries); }
  };
  const { state } = await import('../../web/js/state.js');
  const { handleWsRpcMessage } = await import('../../web/js/ws-rpc.js');
  const picker = await import('../../web/js/project/directory-picker.js');
  const requests = [];
  const settle = () => new Promise(resolve => setImmediate(resolve));
  window.loadViewerLibs = async () => {};
  window.wsSendReliable = request => requests.push(request);
  function reply(request, entries = []) {
    handleWsRpcMessage({
      action: 'project_files', requestId: request.requestId, ok: true,
      path: request.path || '/home/test', targetPath: request.path || '/home/test',
      parentPath: '/home/test', exists: true,
      entries: entries.map(name => ({ name, type: 'directory' })),
    });
  }
  try {
    const opened = picker.browseNewProjectPath('');
    await settle();
    reply(requests[0], ['a', 'b', 'c', 'd', 'e']);
    await opened;
    const rows = [...document.querySelectorAll('#newProjectDirectories button')];
    const observer = observers.at(-1);
    observer.emit(rows.map(target => ({ target, isIntersecting: true })));
    await settle();
    assert.deepEqual(requests.slice(1).map(request => request.path), ['/home/test/a', '/home/test/b', '/home/test/c', '/home/test/d']);
    observer.emit([{ target: rows[4], isIntersecting: false }]);
    reply(requests[1], ['deep']);
    await settle();
    assert.equal(requests.length, 5);
    observer.emit([{ target: rows[4], isIntersecting: true }]);
    await settle();
    assert.equal(requests[5].path, '/home/test/e');
    rows[4].click();
    await settle();
    assert.equal(requests.length, 6);
    assert.equal(document.getElementById('newProjectInput').value, '/home/test/e');
    reply(requests[5]);
    await settle();
    reply(requests[2]);
    reply(requests[3]);
    reply(requests[4]);
    await settle();
    await picker.newProjectParentDirectory();
    assert.equal(requests.length, 6);
    assert.equal(observers[0].disconnected, true);
    assert.equal(requests.some(request => request.path.endsWith('/deep')), false);
  } finally {
    picker.closeNewProjectDirectoryPicker();
    state._pendingCreatePath = null;
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
  }
});
