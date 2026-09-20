import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createTestServer } from './helpers/vite.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');

function pointerEvent(window, type, y) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: 'touch' },
    isPrimary: { value: true },
    button: { value: 0 },
    clientY: { value: y },
  });
  return event;
}

test('returning near the bottom restores following without snapping the current view', async () => {
  const dom = new JSDOM(
    '<!doctype html><body>'
      + '<div class="top-bar"><div class="top-left"></div><div id="top-right"></div></div>'
      + '<div id="breadcrumb"></div>'
      + '<div id="content"><div class="messages"></div></div>'
      + '<div id="input-bar"></div><button id="scroll-bottom-btn"></button>'
      + '</body>',
    { url: 'https://baton.test/index.html', pretendToBeVisual: true },
  );
  const window = dom.window;
  const content = window.document.getElementById('content');
  const messages = window.document.querySelector('.messages');
  const scrollButton = window.document.getElementById('scroll-bottom-btn');
  const resizeObservers = [];
  let scrollHeight = 1000;
  let scrollTop = 700;

  Object.defineProperties(content, {
    clientHeight: { configurable: true, value: 300 },
    scrollHeight: { configurable: true, get: () => scrollHeight },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTop = Math.min(value, scrollHeight - content.clientHeight);
      },
    },
  });
  window.Element.prototype.scrollTo = function (options) {
    this.scrollTop = typeof options === 'object' ? options.top : arguments[1];
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
    CSS: window.CSS,
    getComputedStyle: window.getComputedStyle,
    requestAnimationFrame: function (fn) { return setTimeout(fn, 0); },
    cancelAnimationFrame: clearTimeout,
    disconnectWs: function () {},
    updateSpinner: function () {},
  });
  class TestResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Set();
      resizeObservers.push(this);
    }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  }
  globalThis.ResizeObserver = window.ResizeObserver = TestResizeObserver;
  Object.assign(window, {
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    disconnectWs: globalThis.disconnectWs,
    updateSpinner: globalThis.updateSpinner,
    __homeLoadPromise: new Promise(function () {}),
  });
  function triggerResize(target) {
    for (const observer of resizeObservers) {
      if (observer.targets.has(target)) {
        observer.callback([{ target }], observer);
      }
    }
  }

  const vite = await createTestServer({
    root: path.join(ROOT, 'web'),
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true },
  });

  try {
    await vite.ssrLoadModule('/js/app.js');
    const state = (await vite.ssrLoadModule('/js/state.js')).state;
    state.appState = {
      device: 'D',
      project: { hash: 'P', name: 'Project' },
      session: 'S',
      sessionPreview: '',
    };
    state.stickBottom = true;

    content.dispatchEvent(pointerEvent(window, 'pointerdown', 300));
    content.dispatchEvent(pointerEvent(window, 'pointermove', 294));

    assert.equal(state.stickBottom, false);
    assert.equal(scrollButton.classList.contains('visible'), false);

    scrollTop = 695; // Only 5px from bottom: still a deliberate interruption.
    content.dispatchEvent(new window.Event('scroll'));
    content.dispatchEvent(pointerEvent(window, 'pointerup', 294));
    await new Promise(function (resolve) { setTimeout(resolve, 180); });

    assert.equal(state.stickBottom, false);
    assert.equal(scrollButton.classList.contains('visible'), false);

    scrollHeight = 1120;
    triggerResize(messages);
    assert.equal(scrollTop, 695);
    content.dispatchEvent(new window.Event('scroll'));
    assert.equal(scrollButton.classList.contains('visible'), true);

    // On a real touch scroll, pointermove can observe the new scrollTop before
    // the following scroll event. The first button update that hides it must
    // therefore restore following directly.
    content.dispatchEvent(pointerEvent(window, 'pointerdown', 294));
    scrollTop = 770; // 50px from bottom: button hides, but not yet physical bottom.
    content.dispatchEvent(pointerEvent(window, 'pointermove', 288));
    content.dispatchEvent(new window.Event('scroll'));
    content.dispatchEvent(pointerEvent(window, 'pointermove', 282));
    content.dispatchEvent(pointerEvent(window, 'pointerup', 282));

    assert.equal(state.stickBottom, true);
    assert.equal(scrollTop, 770);
    assert.equal(scrollButton.classList.contains('visible'), false);
    await new Promise(function (resolve) { setTimeout(resolve, 180); });
    assert.equal(state.stickBottom, true);
    assert.equal(scrollTop, 770);

    window.scrollToBottom();
    assert.equal(scrollTop, 820);

    scrollHeight = 1400;
    scrollTop = 700;
    state.stickBottom = true;
    content.dispatchEvent(pointerEvent(window, 'pointerdown', 282));
    content.dispatchEvent(pointerEvent(window, 'pointermove', 270));
    content.dispatchEvent(pointerEvent(window, 'pointerup', 270));
    assert.equal(scrollButton.classList.contains('visible'), true);

    state.appState.session = null;
    scrollButton.classList.remove('visible');
    await new Promise(function (resolve) { setTimeout(resolve, 180); });

    assert.equal(scrollButton.classList.contains('visible'), false);

  } finally {
    await vite.close();
    dom.window.close();
  }
});
