import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createTestServer } from './helpers/vite.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const route = { device: 'Mac', project: { hash: 'project', name: 'Project' }, session: 'codex:root' };
const settle = () => new Promise(resolve => setImmediate(resolve));

async function boot({ storage = {}, appState = route, server = 'https://baton.test' } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="content">Conversation</div></body>', {
    url: 'https://baton.test/', pretendToBeVisual: true,
  });
  const window = dom.window;
  Object.assign(globalThis, {
    window, document: window.document, sessionStorage: window.sessionStorage,
    requestAnimationFrame: callback => setTimeout(callback, 0),
    cancelAnimationFrame: clearTimeout,
  });
  Object.entries(storage).forEach(([key, value]) => window.sessionStorage.setItem(key, value));
  Object.assign(window, {
    loadViewerLibs: async () => {}, connectWs() {}, disconnectWs() {},
  });
  const vite = await createTestServer({
    root: path.join(ROOT, 'web'), logLevel: 'silent', appType: 'custom',
    server: { middlewareMode: true },
  });
  const { state } = await vite.ssrLoadModule('/js/state.js');
  state.appState = structuredClone(appState);
  state.SERVER = server;
  state.wsSessionId = appState.session;
  const { handleWsRpcMessage } = await vite.ssrLoadModule('/js/ws-rpc.js');
  const requests = [];
  let entries = [{ name: 'app.js', type: 'file' }];
  window.wsSendReliable = request => {
    requests.push(request);
    queueMicrotask(() => handleWsRpcMessage({
      action: 'project_files', requestId: request.requestId, ok: true, entries,
    }));
  };
  const page = await vite.ssrLoadModule('/js/project/page.js');
  const content = page.projectFilesContent();
  Object.defineProperties(content, {
    clientHeight: { value: 600 }, scrollHeight: { value: 2400 },
  });
  const browser = await vite.ssrLoadModule('/js/project/browser.js');
  await settle();
  let closed = false;
  return {
    state, browser, window, requests, content,
    setEntries(value) { entries = value; },
    snapshot() {
      return Object.fromEntries(Object.keys(window.sessionStorage).map(key => [key, window.sessionStorage.getItem(key)]));
    },
    async close() {
      if (closed) return;
      closed = true;
      browser.deactivateProjectFiles(true);
      await vite.close();
      dom.window.close();
    },
  };
}

test('files reopen at the same directory and scroll position from a session or Git without refetching', async () => {
  const app = await boot();
  try {
    await app.browser.openProjectFilesPath('web/js');
    app.content.scrollTop = 420;
    assert.equal(app.browser.closeProjectFiles(), true);
    assert.equal(app.snapshot()['baton-project-files-view'], undefined);
    assert.equal(JSON.parse(app.snapshot()['baton-recent-project-files']).scrollTop, 420);

    await app.browser.openProjectFiles();
    assert.equal(app.requests.length, 1);
    assert.equal(app.content.scrollTop, 420);
    assert.equal(document.querySelector('.path-breadcrumb-item:last-child').textContent, 'js');
    assert.equal(document.getElementById('content').textContent, 'Conversation');
    assert.equal(app.state.appState.session, 'codex:root');

    app.content.scrollTop = 680;
    app.browser.closeProjectFiles();
    let gitReturns = 0;
    app.window.openGitStatusPage = () => gitReturns++;
    await app.browser.openProjectFilesFromGit();
    assert.equal(app.requests.length, 1);
    assert.equal(app.content.scrollTop, 680);
    app.browser.closeProjectFiles();
    assert.equal(gitReturns, 1);
    await app.browser.resumeProjectFilesFromGit();
    assert.equal(app.content.scrollTop, 680);
  } finally {
    await app.close();
  }
});

test('stale files appear immediately and refresh without losing the saved scroll position', async context => {
  const app = await boot();
  let now = Date.now();
  context.mock.method(Date, 'now', () => now);
  try {
    await app.browser.openProjectFilesPath('src');
    app.content.scrollTop = 500;
    app.browser.closeProjectFiles();
    now += 31000;
    app.setEntries([{ name: 'updated.js', type: 'file' }]);
    const opening = app.browser.openProjectFiles();
    assert.equal(document.querySelector('.project-file-name').textContent, 'app.js');
    assert.equal(app.content.scrollTop, 500);
    await opening;
    assert.equal(app.requests.length, 2);
    assert.equal(app.requests[1].path, 'src');
    assert.equal(document.querySelector('.project-file-name').textContent, 'updated.js');
    assert.equal(app.content.scrollTop, 500);
  } finally {
    await app.close();
  }
});

for (const session of [null, 'codex:root']) {
  test(`the recent location survives refresh after returning to the ${session ? 'session' : 'list'}`, async () => {
    const appState = { ...route, session };
    let app = await boot({ appState });
    try {
      await app.browser.openProjectFilesPath('web/js');
      app.content.scrollTop = 720;
      app.browser.closeProjectFiles();
      const closedSnapshot = app.snapshot();
      await app.close();
      app = await boot({ storage: closedSnapshot, appState });
      assert.equal(app.state.projectFilesOpen, false);
      assert.equal(app.requests.length, 0);
      await app.browser.openProjectFiles();
      assert.equal(app.requests[0].path, 'web/js');
      assert.equal(app.content.scrollTop, 720);
    } finally {
      await app.close();
    }
  });
}

test('recent files are shared within a project, but never across devices, servers or projects', async () => {
  let app = await boot();
  try {
    await app.browser.openProjectFilesPath('web/js');
    app.content.scrollTop = 360;
    app.browser.closeProjectFiles();
    const storage = app.snapshot();
    await app.close();

    for (const session of [null, 'claude-other']) {
      app = await boot({ storage, appState: { ...route, session } });
      await app.browser.openProjectFiles();
      assert.equal(app.requests[0].path, 'web/js');
      assert.equal(app.content.scrollTop, 360);
      await app.close();
    }

    for (const options of [
      { appState: { ...route, device: 'Other Mac' } },
      { appState: { ...route, project: { hash: 'other', name: 'Other' } } },
      { server: 'https://other.test' },
    ]) {
      app = await boot({ storage, ...options });
      await app.browser.openProjectFiles();
      assert.equal(app.requests[0].path, '');
      assert.equal(app.content.scrollTop, 0);
      assert.equal(JSON.parse(app.snapshot()['baton-recent-project-files']).path, '');
      await app.close();
    }
  } finally {
    await app.close();
  }
});

test('an unavailable session store still allows reopening the last directory from memory', async context => {
  const app = await boot();
  try {
    for (const method of ['getItem', 'setItem', 'removeItem']) {
      context.mock.method(app.window.Storage.prototype, method, () => { throw new Error('Storage unavailable'); });
    }
    await app.browser.openProjectFilesPath('web/js');
    app.content.scrollTop = 450;
    app.browser.closeProjectFiles();
    await app.browser.openProjectFiles();
    assert.equal(app.requests.length, 1);
    assert.equal(app.content.scrollTop, 450);
    assert.equal(document.querySelector('.path-breadcrumb-item:last-child').textContent, 'js');
  } finally {
    await app.close();
  }
});
