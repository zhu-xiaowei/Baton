import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createTestServer } from './helpers/vite.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CSS = readFileSync(path.join(ROOT, 'web/css/style.css'), 'utf8');

test('session toolbar exposes the terminal without losing runtime or agent controls', async context => {
  const dom = new JSDOM('<!doctype html><head><style>' + CSS + '</style></head><body>'
    + '<div class="top-bar"><div class="top-left"><span class="top-logo" aria-hidden="true">'
    + '<img src="assets/baton-logo.svg" alt=""></span></div><div id="top-right"></div></div>'
    + '<div id="breadcrumb" class="breadcrumb"></div><div id="content">Existing conversation</div>'
    + '<div id="input-bar"><textarea id="msg-input"></textarea><button id="send-btn"></button></div>'
    + '<button id="scroll-bottom-btn"></button></body>', {
    url: 'https://baton.test/index.html', pretendToBeVisual: true, runScripts: 'dangerously',
  });
  const window = dom.window;
  Object.assign(globalThis, {
    window, document: window.document, navigator: window.navigator,
    location: window.location, history: window.history,
    localStorage: window.localStorage, sessionStorage: window.sessionStorage,
    Element: window.Element, HTMLElement: window.HTMLElement, Node: window.Node, CSS: window.CSS,
    getComputedStyle: window.getComputedStyle,
    requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
    connectWs() {}, disconnectWs() {}, updateSpinner() {}, updateSendBtn() {}, dismissPermissionPrompt() {},
  });
  Object.assign(window, {
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    loadViewerLibs: async () => {},
    __homeLoadPromise: new Promise(() => {}),
    __terminalOpenCalls: [],
  });
  const vite = await createTestServer({
    root: path.join(ROOT, 'web'), logLevel: 'silent', appType: 'custom',
    server: { middlewareMode: true },
    plugins: [{
      name: 'session-toolbar-terminal-fixture', enforce: 'pre',
      resolveId(source, importer) {
        if (source === './terminal.js' && importer?.endsWith('/js/app.js')) return '\0session-toolbar-terminal';
      },
      load(id) {
        if (id === '\0session-toolbar-terminal') {
          return 'export function openProjectTerminal(options) { window.__terminalOpenCalls.push(options); }';
        }
      },
    }],
  });

  try {
    await vite.ssrLoadModule('/js/app.js');
    const state = (await vite.ssrLoadModule('/js/state.js')).state;
    const brandMarkup = document.querySelector('.top-logo').outerHTML;
    function showSession(runtime = 'codex') {
      state.appState = {
        device: 'Mac', project: { hash: 'project', name: 'Project' },
        session: runtime === 'codex' ? 'codex:root' : 'claude-root',
        runtime, sessionPreview: 'Inspect a conversation title', isAgent: true,
      };
      state.rootSessionId = state.appState.session;
      state.rootSessionPreview = state.appState.sessionPreview;
      state.sessionThreads = [];
      window.updateBreadcrumb();
    }

    await context.test('runtime and Agent capsules follow the title without losing header actions', () => {
      for (const runtime of ['codex', 'claude']) {
        showSession(runtime);
        assert.deepEqual([...document.querySelectorAll('#top-right > button')].map(
          button => button.classList.contains('archive-action') ? button.textContent : button.title,
        ), [
          'Git changes', 'Terminal', 'New Session', ...(runtime === 'codex' ? ['Archive'] : []),
        ]);
        const meta = document.querySelector('.session-title-meta');
        assert.ok(meta.previousElementSibling.classList.contains('breadcrumb-title'));
        assert.deepEqual([...meta.querySelectorAll('.badge')].map(badge => badge.textContent), [
          runtime === 'codex' ? 'Codex' : 'Claude', 'Agent',
        ]);
        assert.equal(getComputedStyle(meta).display, 'inline-flex');
        assert.equal(document.querySelector('#top-right .runtime-mark'), null);
        assert.equal(document.querySelector('.top-logo').outerHTML, brandMarkup);
      }
    });

    await context.test('capsules fit inline or reveal on expansion, and respond to resizing', async () => {
      showSession();
      document.documentElement.classList.add('native-mobile');
      const nav = document.querySelector('.breadcrumb-nav');
      const meta = nav.querySelector('.session-title-meta');
      let availableWidth = 320;
      Object.defineProperties(nav, {
        clientWidth: { get: () => availableWidth },
        scrollWidth: { get: () => nav.classList.contains('is-truncated') ? 280 : 420 },
      });
      for (const width of [320, 420, 320]) {
        availableWidth = width;
        window.dispatchEvent(new window.Event('resize'));
        await new Promise(resolve => requestAnimationFrame(resolve));
        assert.equal(getComputedStyle(meta).display, width < 420 ? 'none' : 'inline-flex');
      }
      nav.click();
      await new Promise(resolve => requestAnimationFrame(resolve));
      assert.equal(getComputedStyle(meta).display, 'inline-flex');
      nav.click();
      await new Promise(resolve => requestAnimationFrame(resolve));
      assert.equal(getComputedStyle(meta).display, 'none');
      document.documentElement.classList.remove('native-mobile');
    });

    await context.test('the runtime capsule opens agent threads without collapsing the title', () => {
      showSession();
      state.sessionThreads = [
        { sessionId: 'codex:root', status: 'completed' },
        { sessionId: 'codex:child', status: 'running' },
      ];
      window.updateBreadcrumb();
      const nav = document.querySelector('.breadcrumb-nav');
      nav.classList.add('expanded');
      const trigger = nav.querySelector('.agent-thread-trigger');
      assert.equal(trigger.getAttribute('aria-controls'), 'agentThreadsModal');
      assert.ok(trigger.querySelector('.agent-thread-dot.running'));
      let opened = 0;
      const originalOpen = window.openAgentThreadsModal;
      window.openAgentThreadsModal = () => { opened++; };
      try {
        trigger.click();
        assert.equal(opened, 1);
        assert.equal(nav.classList.contains('expanded'), true);
      } finally {
        window.openAgentThreadsModal = originalOpen;
      }
    });

    await context.test('terminal opens from detail and list, but not the new-session composer', async () => {
      showSession();
      for (const session of ['codex:root', null, '__new__']) {
        state.appState.session = session;
        window.updateBreadcrumb();
        const button = document.querySelector('.project-terminal-entry');
        assert.equal(!!button, session !== '__new__');
        if (button) assert.equal(button.getAttribute('onclick'), 'openProjectTerminalPage()');
        const count = window.__terminalOpenCalls.length;
        const opening = window.openProjectTerminalPage();
        assert.equal(window.__terminalOpenCalls.length, count + (session === '__new__' ? 0 : 1));
        await opening;
        assert.equal(state.appState.session, session);
        assert.equal(document.getElementById('content').textContent, 'Existing conversation');
      }
      assert.deepEqual(window.__terminalOpenCalls[0], { device: 'Mac', projectHash: 'project', projectName: 'Project' });
    });

    await context.test('archived metadata keeps runtime and Agent capsules and offers Restore', async () => {
      const { rememberArchiveMetadata } = await vite.ssrLoadModule('/js/session-archive.js');
      showSession();
      rememberArchiveMetadata({ sessionId: 'codex:root', archiveState: 'archived', archiveVersion: 1 });
      window.updateBreadcrumb();
      assert.deepEqual([...document.querySelectorAll('.session-title-meta .badge')].map(badge => badge.textContent), [
        'Codex', 'Agent', 'Archived',
      ]);
      assert.equal(document.querySelector('#top-right .archive-action').textContent, 'Restore');
      assert.ok(document.querySelector('.project-terminal-entry'));

      rememberArchiveMetadata({ sessionId: 'codex:root', archiveState: 'unarchived', archiveVersion: 2 });
      window.updateBreadcrumb();
      assert.equal(document.querySelector('.session-title-meta .archived'), null);
      assert.equal(document.querySelector('#top-right .archive-action').textContent, 'Archive');
    });
  } finally {
    await vite.close();
    dom.window.close();
  }
});
