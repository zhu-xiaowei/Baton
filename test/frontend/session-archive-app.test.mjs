import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { LIST_PAGE_SIZE } from '../../web/js/list-pagination.js';

const ROOT = path.resolve(import.meta.dirname, '../..');

async function waitFor(predicate) {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for archive view');
}

async function appHarness(t, api, apiPost = async () => ({})) {
  const dom = new JSDOM(
    '<!doctype html><body>'
      + '<div class="top-bar"><div class="top-left"></div><div id="top-right"></div></div>'
      + '<div id="breadcrumb"></div><div id="content"></div>'
      + '<div id="input-bar"><textarea id="msg-input"></textarea><button id="send-btn"></button></div>'
      + '<button id="scroll-bottom-btn"></button>'
      + '<div id="deleteModal"><input id="deleteFilesCb" type="checkbox">'
      + '<button id="deleteConfirmBtn"></button><div id="deleteError"></div></div></body>',
    { url: 'https://baton.test/index.html', pretendToBeVisual: true },
  );
  const window = dom.window;
  const content = window.document.getElementById('content');
  Object.defineProperty(content, 'clientHeight', { configurable: true, value: 600 });
  Object.defineProperty(content, 'scrollHeight', {
    configurable: true,
    get() { return content.querySelectorAll('.list > .item[data-id]').length * 64; },
  });
  window.Element.prototype.scrollTo = function (options) {
    this.scrollTop = typeof options === 'object' ? options.top : arguments[1];
  };
  const globals = {
    window, document: window.document, navigator: window.navigator,
    location: window.location, history: window.history,
    localStorage: window.localStorage, sessionStorage: window.sessionStorage,
    Element: window.Element, HTMLElement: window.HTMLElement, Node: window.Node,
    CSS: window.CSS, getComputedStyle: window.getComputedStyle,
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    cancelAnimationFrame: clearTimeout, api, apiPost,
    disconnectWs() {}, updateSpinner() {}, updateSendBtn() {},
    skeletonItems() { return ''; }, skeletonMessages() { return ''; },
  };
  const previous = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  Object.assign(globalThis, globals);
  for (const key of [
    'requestAnimationFrame', 'cancelAnimationFrame', 'api', 'apiPost',
    'disconnectWs', 'updateSpinner', 'updateSendBtn', 'skeletonItems', 'skeletonMessages',
  ]) window[key] = globals[key];
  window.__APEEK_TEST__ = true;
  window.__setTopSync = () => {};
  window.loadViewerLibs = () => new Promise(() => {});
  const vite = await createServer({
    root: path.join(ROOT, 'web'), logLevel: 'silent', appType: 'custom',
    server: { middlewareMode: true },
  });
  t.after(async () => {
    await vite.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  await vite.ssrLoadModule('/js/app.js');
  const { state } = await vite.ssrLoadModule('/js/state.js');
  const listCache = await vite.ssrLoadModule('/js/list-cache.js');
  return { window, document: window.document, content, state, listCache };
}

for (const rootChanges of [false, true]) {
  test(`stale thread response cannot disable restored ${rootChanges ? 'parent/child' : 'main'} detail`, async (t) => {
    const rootId = 'codex:root';
    const sessionId = rootChanges ? 'codex:child' : rootId;
    const fresh = {
      sessionId, archiveState: 'unarchived', archiveVersion: rootChanges ? 5 : 11,
      rootSessionId: rootId, rootArchiveState: 'unarchived', rootArchiveVersion: 11,
      canSend: true,
    };
    const stale = {
      ...fresh, archiveState: rootChanges ? 'unarchived' : 'archived',
      archiveVersion: rootChanges ? 5 : 10, rootArchiveState: 'archived',
      rootArchiveVersion: 10, canSend: false,
    };
    let resolveThreads;
    const response = new Promise((resolve) => { resolveThreads = resolve; });
    const h = await appHarness(t, async (pathname) => {
      assert.equal(pathname, '/api/bridge/session-threads');
      return response;
    });
    Object.assign(h.state, {
      appState: { device: 'D', project: { hash: 'P', name: 'Project' }, session: rootId },
      rootSessionId: rootId, activeThreadId: sessionId, wsSessionId: sessionId,
      archiveCheckRequired: true, activeThreadCanSend: false,
    });
    const refresh = h.window.refreshSessionThreads();
    h.window.applyArchiveMetadata(fresh, sessionId);
    assert.equal(h.document.getElementById('msg-input').readOnly, false);
    resolveThreads({ rootSessionId: rootId, threads: rootChanges ? [{
      sessionId: rootId, archiveState: 'archived', archiveVersion: 10, canSend: false,
    }, stale] : [stale] });
    await refresh;
    assert.equal(h.state.activeThreadCanSend, true);
    assert.equal(h.document.getElementById('msg-input').readOnly, false);
    assert.equal(h.document.getElementById('input-bar').hasAttribute('inert'), false);
    assert.equal(h.document.getElementById('session-archive-banner'), null);
  });
}

test('restoring the parent leaves archived children and intrinsic read-only children blocked', async (t) => {
  const root = {
    sessionId: 'codex:root', archiveState: 'unarchived', archiveVersion: 11,
    rootSessionId: 'codex:root', rootArchiveState: 'unarchived', rootArchiveVersion: 11,
    canSend: true,
  };
  const child = {
    ...root, sessionId: 'codex:child', archiveState: 'archived', archiveVersion: 6,
    parentSessionId: 'codex:root', canSend: false,
  };
  const restricted = {
    ...root, sessionId: 'codex:restricted', archiveVersion: 3,
    parentSessionId: 'codex:root', canSend: false,
  };
  const h = await appHarness(t, async () => ({ rootSessionId: root.sessionId, threads: [root, child, restricted] }));
  Object.assign(h.state, {
    appState: { device: 'D', project: { hash: 'P', name: 'Project' }, session: root.sessionId },
    rootSessionId: root.sessionId, activeThreadId: child.sessionId, wsSessionId: child.sessionId,
    archiveCheckRequired: true,
  });
  await h.window.refreshSessionThreads();
  assert.equal(h.document.getElementById('msg-input').readOnly, true);
  assert.match(h.document.getElementById('session-archive-banner').textContent, /Restore/);

  h.state.activeThreadId = h.state.wsSessionId = restricted.sessionId;
  await h.window.refreshSessionThreads();
  assert.equal(h.document.getElementById('msg-input').readOnly, true);
  assert.equal(h.document.getElementById('msg-input').placeholder, 'Subagent is read-only');
  assert.equal(h.document.getElementById('session-archive-banner'), null);
});

for (const deletion of ['archived-session', 'open-session', 'project']) {
  test(`${deletion} deletion invalidates both filters after loading two pages`, async (t) => {
    let rows = Array.from({ length: 60 }, (_, index) => index + 1).flatMap((number) => (
      ['archived', 'unarchived'].map((archiveState) => ({
        sessionId: `codex:${archiveState === 'archived' ? 'a' : 'o'}${number}`,
        preview: `Session ${number}`, status: 'completed', size: 1, model: 'test',
        lastActive: new Date(Date.UTC(2026, 8, 16, 0, 0, number)).toISOString(),
        archiveState, archiveVersion: 1,
      }))
    )).sort((a, b) => b.lastActive.localeCompare(a.lastActive));
    let projectExists = true;
    const posts = [];
    const h = await appHarness(t, async (pathname, params) => {
      if (pathname === '/api/bridge/devices') return { devices: [] };
      if (pathname === '/api/bridge/projects') return {
        projects: projectExists ? [{ projectHash: 'P', projectName: 'Project', sessionCount: 60 }] : [],
        hasMore: false,
      };
      assert.equal(pathname, '/api/bridge/sessions');
      const filtered = rows.filter((row) => (row.archiveState === 'archived') === params.archived);
      const start = params.cursor ? LIST_PAGE_SIZE : 0;
      return {
        sessions: filtered.slice(start, start + LIST_PAGE_SIZE),
        hasMore: start + LIST_PAGE_SIZE < filtered.length,
        nextCursor: start + LIST_PAGE_SIZE < filtered.length ? 'page-2' : null,
      };
    }, async (pathname, body) => {
      assert.equal(pathname, '/api/bridge/delete');
      posts.push(body);
      if (body.projectHashes) {
        projectExists = false;
        rows = [];
      } else rows = rows.filter((row) => !body.sessionIds.includes(row.sessionId));
      return {};
    });
    const openKey = 'sessions:D:P';
    const archiveKey = `${openKey}:archived`;
    for (const filter of ['sessions', 'archived']) {
      await h.window.loadSessions('D', 'P', 'Project', filter);
      await h.window.__listTest.loadNext();
      assert.equal(h.content.querySelectorAll('.item[data-id]').length, 60);
    }
    if (deletion === 'project') await h.window.loadProjects('D');
    else if (deletion === 'open-session') await h.window.loadSessions('D', 'P', 'Project', 'sessions');
    const id = deletion === 'project' ? 'P' : deletion === 'archived-session' ? 'codex:a1' : 'codex:o1';
    h.state.selectMode = true;
    h.state.selectType = deletion === 'project' ? 'project' : 'session';
    h.state.selected = new Set([id]);
    await h.window.submitDelete();
    const activeKey = deletion === 'project' ? 'projects:D'
      : deletion === 'archived-session' ? archiveKey : openKey;
    await waitFor(() => {
      const entry = h.window.__listTest.get(activeKey);
      return entry?.loaded && !entry.loading;
    });
    assert.equal(posts.length, 1);
    assert.equal(h.content.querySelector(`[data-id="${id}"]`), null);
    if (deletion === 'project') {
      for (const key of [openKey, archiveKey]) {
        assert.equal(h.window.__listTest.get(key), null);
        assert.equal(h.listCache.readListCache(key), null);
      }
    } else {
      await h.window.__listTest.loadNext();
      assert.equal(h.content.querySelectorAll('.item[data-id]').length, 59);
      const inactiveKey = deletion === 'archived-session' ? openKey : archiveKey;
      assert.equal(h.window.__listTest.get(inactiveKey), null);
      assert.equal(h.listCache.readListCache(inactiveKey), null);
    }
  });
}
