import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createTestServer } from './helpers/vite.mjs';
import { TERMINAL_VIEW_KEY, saveTerminalView, shouldRestoreTerminal } from '../../web/js/terminal-view-state.js';

const ROOT = path.resolve(import.meta.dirname, '../..');

async function boot(savedStorage = {}) {
  const dom = new JSDOM('<!doctype html><body><div class="top-bar"><div id="top-right"></div></div>'
    + '<div id="breadcrumb"></div><div id="content"></div>'
    + '<div id="input-bar"><textarea id="msg-input"></textarea><button id="send-btn"></button></div>'
    + '<button id="scroll-bottom-btn"></button></body>', {
    url: 'https://baton.test/index.html', pretendToBeVisual: true,
  });
  const window = dom.window;
  for (const [key, value] of Object.entries(savedStorage)) window.sessionStorage.setItem(key, value);
  Object.assign(globalThis, {
    window, document: window.document, navigator: window.navigator,
    location: window.location, history: window.history,
    localStorage: window.localStorage, sessionStorage: window.sessionStorage,
    Element: window.Element, HTMLElement: window.HTMLElement, Node: window.Node, CSS: window.CSS,
    getComputedStyle: window.getComputedStyle,
    requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
    connectWs() {}, disconnectWs() {}, updateSpinner() {}, updateSendBtn() {}, dismissPermissionPrompt() {},
    skeletonItems: () => '', skeletonMessages: () => '<div class="messages"></div>',
    api: () => new Promise(() => {}),
  });
  Object.assign(window, {
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    loadViewerLibs: () => new Promise(() => {}),
  });
  const vite = await createTestServer({
    root: path.join(ROOT, 'web'), logLevel: 'silent', appType: 'custom',
    server: { middlewareMode: true },
    plugins: [{
      name: 'terminal-refresh-runtime-fixture', enforce: 'pre',
      resolveId(source, importer) {
        if (source === './terminal-runtime.js' && importer?.endsWith('/js/terminal.js')) return '\0terminal-refresh-runtime';
      },
      load(id) {
        if (id === '\0terminal-refresh-runtime') {
          return 'export class Terminal { constructor(options) { window.__terminalOptions = options; throw new Error("Runtime unavailable"); } }';
        }
      },
    }],
  });
  try {
    const state = (await vite.ssrLoadModule('/js/state.js')).state;
    state.KEY = savedStorage['baton-nav'] ? 'test-key' : '';
    await vite.ssrLoadModule('/js/app.js');
    return {
      window, state,
      snapshot() {
        return Object.fromEntries(Object.keys(window.sessionStorage).map(key => [key, window.sessionStorage.getItem(key)]));
      },
      async close() {
        window.closeProjectTerminal?.();
        await vite.close();
        dom.window.close();
      },
    };
  } catch (error) {
    await vite.close();
    dom.window.close();
    throw error;
  }
}

for (const session of [null, 'codex:root']) {
  test(`refresh restores Terminal above the ${session ? 'session' : 'project'} page, including initialization failure`, async context => {
    context.mock.method(console, 'error', () => {});
    const route = { device: 'Mac', project: { hash: 'project', name: 'Project' }, session, sessionPreview: 'Conversation' };
    let browser = await boot();
    try {
      browser.state.appState = route;
      const selectionKey = 'terminal-selection:' + JSON.stringify([null, 'Mac', 'project']);
      browser.window.sessionStorage.setItem(selectionKey, 'terminal-2');
      await browser.window.openProjectTerminalPage();
      assert.ok(browser.window.document.getElementById('projectTerminalPage'));
      assert.equal(browser.window.document.querySelector('.project-terminal-status').dataset.state, 'error');
      assert.equal(shouldRestoreTerminal(route, browser.window.sessionStorage), true);
      assert.deepEqual(JSON.parse(browser.window.sessionStorage.getItem('baton-nav')), route);

      browser.window.dispatchEvent(new browser.window.Event('pagehide'));
      assert.equal(browser.window.document.getElementById('projectTerminalPage'), null);
      assert.equal(shouldRestoreTerminal(route, browser.window.sessionStorage), true);
      const beforeRefresh = browser.snapshot();
      await browser.close();
      browser = await boot(beforeRefresh);
      assert.ok(browser.window.document.getElementById('projectTerminalPage'));
      assert.equal(browser.state.appState.session, session);
      assert.equal(browser.window.sessionStorage.getItem(selectionKey), 'terminal-2');
      await browser.window.openProjectTerminalPage();

      browser.window.document.querySelector('#projectTerminalPage .back-button').click();
      assert.equal(browser.window.document.getElementById('projectTerminalPage'), null);
      assert.equal(browser.window.sessionStorage.getItem(TERMINAL_VIEW_KEY), null);
      const afterBack = browser.snapshot();
      await browser.close();
      browser = await boot(afterBack);
      assert.equal(browser.window.document.getElementById('projectTerminalPage'), null);
      assert.equal(browser.state.appState.session, session);
    } finally {
      await browser.close();
    }
  });
}

test('the mobile terminal uses the page scrollbar width and colors', async context => {
  context.mock.method(console, 'error', () => {});
  const browser = await boot();
  try {
    browser.window.document.documentElement.classList.add('native-mobile');
    browser.state.appState = { device: 'Mac', project: { hash: 'project', name: 'Project' }, session: null };
    await browser.window.openProjectTerminalPage();
    const options = browser.window.__terminalOptions;
    assert.equal(options.scrollbar?.width, 6);
    assert.equal(options.fontSize, 14);
    assert.equal(options.theme.scrollbarSliderBackground, '#3a4049');
    assert.equal(options.theme.scrollbarSliderHoverBackground, '#4a5059');
    assert.equal(options.theme.scrollbarSliderActiveBackground, '#4a5059');
    assert.equal(options.theme.overviewRulerBorder, '#00000000');
  } finally {
    await browser.close();
  }
});

test('terminal restoration ignores stale routes and malformed or unavailable storage', () => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  const route = { device: 'Mac', project: { hash: 'project' }, session: 'session' };
  for (const changed of [
    { ...route, device: 'Other' },
    { ...route, project: { hash: 'other' } },
    { ...route, session: 'other' },
    { ...route, session: '__new__' },
    { device: null, project: null, session: null },
  ]) {
    saveTerminalView(route, storage);
    assert.equal(shouldRestoreTerminal(changed, storage), false);
    assert.equal(storage.getItem(TERMINAL_VIEW_KEY), null);
  }
  storage.setItem(TERMINAL_VIEW_KEY, '{broken');
  assert.equal(shouldRestoreTerminal(route, storage), false);
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  assert.doesNotThrow(() => saveTerminalView(route, blocked));
  assert.equal(shouldRestoreTerminal(route, blocked), false);
});
