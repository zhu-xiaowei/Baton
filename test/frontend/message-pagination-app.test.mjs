import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createTestServer } from './helpers/vite.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');

test('an underfilled message viewport auto-prepends once and preserves the anchor', async () => {
  const dom = new JSDOM(
    '<!doctype html><body>'
      + '<div class="top-bar"><div class="top-left"></div></div>'
      + '<div id="breadcrumb"></div>'
      + '<div id="content"><div class="messages">'
      + '<div class="loading-older">Loading...</div>'
      + '<div class="msg-user" data-message-id="current">current</div>'
      + '</div></div>'
      + '<div id="input-bar"></div><button id="scroll-bottom-btn"></button>'
      + '</body>',
    { url: 'https://baton.test/index.html', pretendToBeVisual: true },
  );
  const window = dom.window;
  const content = window.document.getElementById('content');
  const container = content.querySelector('.messages');
  const current = container.querySelector('[data-message-id="current"]');
  content.scrollTop = 50;
  current.getBoundingClientRect = function () {
    const olderCount = container.querySelectorAll('.older-message').length;
    const top = 250 + olderCount * 100.25 - content.scrollTop;
    return new window.DOMRect(0, top, 300, 50);
  };

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
    CSS: { supports: () => true },
    getComputedStyle: window.getComputedStyle,
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    cancelAnimationFrame: clearTimeout,
  });
  window.requestAnimationFrame = globalThis.requestAnimationFrame;
  window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
  window.__APEEK_TEST__ = true;
  window.__setTopSync = function () {};
  window.loadViewerLibs = function () { return new Promise(function () {}); };

  const olderMessages = [
    { uuid: 'older-a', type: 'user', content: 'older a' },
    { uuid: 'older-b', type: 'user', content: 'older b' },
  ];
  let renderCalls = 0;
  const globals = {
    loadOlderMessages: async function () {
      const stateModule = await vite.ssrLoadModule('/js/state.js');
      stateModule.state.wsHasMore = false;
      return olderMessages;
    },
    renderMessages: function (messages, runtime) {
      renderCalls++;
      assert.equal(runtime, 'codex');
      return messages.map(function (message) {
        return '<div class="msg-user older-message" data-message-id="'
          + message.uuid + '">' + message.content + '</div>';
      }).join('');
    },
    markTurnAdjacency: function () {},
    loadImages: function () {},
    clampOverflow: function () {},
    renderMermaidBlocks: function () {},
    renderKatexBlocks: function () {},
    updateSpinner: function () {},
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
    const stateModule = await vite.ssrLoadModule('/js/state.js');
    stateModule.state.appState = {
      device: 'D',
      project: { hash: 'P' },
      session: 'pagination-session',
      runtime: 'codex',
    };
    stateModule.state.wsHasMore = true;
    stateModule.state.wsLoadingOlder = false;
    stateModule.state.stickBottom = false;

    assert.equal(await window.maybeLoadOlderAndPrepend(), true);

    const loader = container.querySelector(':scope > .loading-older');
    assert.equal(renderCalls, 1);
    assert.equal(loader.classList.contains('exhausted'), true);
    assert.equal(container.lastElementChild, current);
    assert.deepEqual(
      Array.from(container.children).map((element) => element.dataset.messageId || 'loader'),
      ['loader', 'older-a', 'older-b', 'current'],
    );
    assert.equal(content.scrollTop, 250.5);
  } finally {
    await vite.close();
    dom.window.close();
  }
});
