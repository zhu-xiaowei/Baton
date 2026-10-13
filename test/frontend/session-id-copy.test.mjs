import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createTestServer } from './helpers/vite.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CLAUDE_ID = '136088bc-2892-4d0b-8fac-578d70ed7727';
const WAITING_ID = '0b9e7247-7649-4392-8725-eadd26c06342';
const CODEX_ID = 'codex:019a0000-0000-7000-8000-00000000abcd';

function session(sessionId, extra = {}) {
  return {
    sessionId,
    preview: sessionId,
    lastActive: new Date(Date.UTC(2026, 9, 13)).toISOString(),
    size: 2048,
    model: 'test-model',
    status: 'completed',
    ...extra,
  };
}

test('clicking a Claude session ID copies its resume command and shows a check for two seconds', async (t) => {
  const dom = new JSDOM(
    '<!doctype html><body>'
      + '<div class="top-bar"><div class="top-left"></div><div id="top-right"></div></div>'
      + '<div id="breadcrumb"></div><div id="content"></div>'
      + '<div id="input-bar"></div><button id="scroll-bottom-btn"></button>'
      + '</body>',
    { url: 'https://baton.test/index.html', pretendToBeVisual: true }
  );
  const window = dom.window;
  const copied = [];
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async function (text) { copied.push(text); } },
  });
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    history: window.history,
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    CSS: window.CSS,
    getComputedStyle: window.getComputedStyle,
    requestAnimationFrame: function (fn) { return setTimeout(fn, 0); },
    cancelAnimationFrame: clearTimeout,
  });
  window.requestAnimationFrame = globalThis.requestAnimationFrame;
  window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
  window.__APEEK_TEST__ = true;
  window.__setTopSync = function () {};
  window.loadViewerLibs = function () { return new Promise(function () {}); };

  async function api(pathname) {
    if (pathname !== '/api/bridge/sessions') throw new Error(`Unexpected request: ${pathname}`);
    return {
      sessions: [
        session(CLAUDE_ID),
        session(WAITING_ID, { status: 'needs_input', agentDetail: 'Approve Bash' }),
        session(CODEX_ID),
      ],
      hasMore: false,
      nextCursor: null,
    };
  }
  const globals = {
    api,
    disconnectWs: function () {},
    updateSpinner: function () {},
    skeletonItems: function () { return ''; },
    skeletonMessages: function () { return ''; },
  };
  Object.assign(globalThis, globals);
  Object.assign(window, globals);

  const vite = await createTestServer({
    root: path.join(ROOT, 'web'),
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true },
  });
  try {
    await vite.ssrLoadModule('/js/app.js');
    await window.loadSessions('D', 'P', 'Project');
    const content = window.document.getElementById('content');
    const row = function (id) { return content.querySelector(`.item[data-id="${id}"]`); };
    let navigations = 0;
    content.querySelectorAll('.item[data-id]').forEach(function (item) {
      item.addEventListener('click', function () { navigations += 1; });
    });

    assert.equal(row(CODEX_ID).querySelector('.meta-sid-copy').dataset.copy, 'codex resume 019a0000-0000-7000-8000-00000000abcd');

    t.mock.timers.enable({ apis: ['setTimeout'] });
    const id = row(CLAUDE_ID).querySelector('.meta-sid-copy');
    assert.equal(id.textContent, '136088bc');
    const click = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    id.dispatchEvent(click);
    await Promise.resolve();
    assert.equal(click.defaultPrevented, true);
    assert.equal(navigations, 0);
    assert.deepEqual(copied, [`claude --resume ${CLAUDE_ID}`]);
    assert.equal(id.textContent, '✓');

    t.mock.timers.tick(1999);
    assert.equal(id.textContent, '✓');
    t.mock.timers.tick(1);
    assert.equal(id.textContent, '136088bc');

    const toggle = row(WAITING_ID).querySelector('.session-secondary-toggle');
    toggle.querySelector('.meta-sid-copy').dispatchEvent(
      new window.MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
    assert.equal(toggle.classList.contains('show-meta'), false);
    assert.equal(navigations, 0);
    assert.deepEqual(copied.at(-1), `claude --resume ${WAITING_ID}`);
  } finally {
    t.mock.timers.reset();
    await vite.close();
  }
});
