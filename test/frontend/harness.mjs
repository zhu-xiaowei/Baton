// jsdom harness that loads the REAL web/js/ws.js render code and lets tests replay a
// WS event sequence through it, then inspect the resulting DOM. This is how we reproduce
// and verify stream-render bugs (ordering, duplicates, back-to-back sends) against the
// actual code path rather than a reimplementation. See test/frontend/README.md.
//
// Requires the __APEEK_TEST__ hooks in ws.js (window.__wsTest). Gated on that global so
// production is unaffected.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
import { fileURLToPath } from 'url';
import path from 'path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Build a jsdom window, mock ws.js's render/util globals, load real ws.js + state.
// Returns { state, ws, hooks, document, dumpDom, tick }.
export async function makeHarness(options = {}) {
  const dom = new JSDOM(
    '<!DOCTYPE html><body><div id="content"><div class="messages"></div></div>' +
    '<div id="input-bar"><textarea id="msg-input"></textarea><button id="send-btn"></button></div>' +
    '<div id="codexTakeoverModal" style="display:none"><div id="codexTakeoverDesc"></div>' +
    '<div id="codexTakeoverError"></div><button id="codexTakeoverCancel"></button>' +
    '<button id="codexTakeoverConfirm"></button></div></body>',
    { url: 'https://test/', pretendToBeVisual: true }
  );
  const w = dom.window;
  if (options.userAgent) {
    Object.defineProperty(w.navigator, 'userAgent', {
      configurable: true,
      value: options.userAgent,
    });
  }
  let visualViewport = null;
  if (options.visualViewport) {
    const listeners = new Map();
    visualViewport = {
      height: options.visualViewport.height,
      offsetTop: options.visualViewport.offsetTop || 0,
      addEventListener(type, listener) {
        const handlers = listeners.get(type) || [];
        handlers.push(listener);
        listeners.set(type, handlers);
      },
      dispatch(type) {
        for (const listener of listeners.get(type) || []) listener();
      },
    };
    Object.defineProperty(w, 'visualViewport', {
      configurable: true,
      value: visualViewport,
    });
  }
  globalThis.window = w; globalThis.document = w.document; globalThis.navigator = w.navigator;
  globalThis.WebSocket = function () {}; globalThis.WebSocket.OPEN = 1;
  // Synchronous-ish rAF (bounded to avoid the self-scheduling tickStreams loop spinning).
  let rafN = 0;
  globalThis.requestAnimationFrame = (fn) => (rafN++ > 5000 ? 0 : setTimeout(() => fn(Date.now() + rafN * 40), 0));
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  w.requestAnimationFrame = globalThis.requestAnimationFrame;
  w.cancelAnimationFrame = globalThis.cancelAnimationFrame;
  if (!globalThis.performance) globalThis.performance = { now: () => Date.now() };
  // jsdom elements lack scrollTo/scrollIntoView; stub so doSend's scroll calls don't throw.
  w.Element.prototype.scrollTo = w.Element.prototype.scrollTo || function () {};
  w.Element.prototype.scrollIntoView = w.Element.prototype.scrollIntoView || function () {};
  w.__APEEK_TEST__ = true;

  // Mock the render + util globals ws.js calls (defined in render.js/util.js/app.js in prod).
  // Kept minimal but structurally faithful: user→.msg-user, assistant text→.assistant-text.
  const G = (k, v) => { globalThis[k] = v; w[k] = v; };
  const textOf = (c) => Array.isArray(c) ? c.filter(b => b && b.type === 'text').map(b => b.text).join('') : (typeof c === 'string' ? c : '');
  // Faithful to render.js: data-ts is on the INNER tl-item; the outer assistant-turn has none.
  // renderSingleMessage (incremental) also emits the inner tl-item with data-ts.
  const INTERRUPT_MAP = { '[Request interrupted by user]': 'Interrupted', '[Request interrupted by user for tool use]': 'Tool interrupted' };
  const isInterrupt = (m) => m.type === 'user' && Array.isArray(m.content) && m.content.length === 1 && m.content[0].type === 'text' && !!INTERRUPT_MAP[m.content[0].text];
  G('renderUserBubble', (m) => '<div class="msg-user"'
    + (m.turnId ? ' data-anchor="' + m.turnId + '"' : '')
    + (m.timestamp ? ' data-ts="' + m.timestamp + '"' : '')
    + '>' + textOf(m.content) + '</div>');
  G('renderSingleMessage', (m) => {
    if (isInterrupt(m)) return '<div class="tl-item msg-interrupt"'
      + (m.uuid ? ' data-message-id="' + m.uuid + '"' : '')
      + (m.nativeId ? ' data-native-id="' + m.nativeId + '"' : '')
      + ' data-ts="' + (m.timestamp || '') + '">' + INTERRUPT_MAP[m.content[0].text] + '</div>';
    const t = textOf(m.content); return t ? '<div class="tl-item assistant-text"'
      + (m.uuid ? ' data-message-id="' + m.uuid + '"' : '')
      + (m.nativeId ? ' data-native-id="' + m.nativeId + '"' : '')
      + ' data-ts="' + (m.timestamp || '') + '">' + t + '</div>' : '';
  });
  G('renderMessages', (msgs) => msgs.map(m => {
    if (m.type === 'user') return '<div class="msg-user"'
      + (m.turnId ? ' data-anchor="' + m.turnId + '"' : '')
      + (m.timestamp ? ' data-ts="' + m.timestamp + '"' : '')
      + '>' + textOf(m.content) + '</div>';
    if (m.type === 'assistant') {
      if (m._strictManaged) return '';
      const t = textOf(m.content);
      return t ? '<div class="assistant-turn"><div class="tl-item assistant-text"'
        + (m.uuid ? ' data-message-id="' + m.uuid + '"' : '')
        + (m.nativeId ? ' data-native-id="' + m.nativeId + '"' : '')
        + ' data-ts="' + (m.timestamp || '') + '">' + t + '</div></div>' : '';
    }
    return '';
  }).join(''));
  G('isInterruptMsg', isInterrupt); // real logic — an interrupt row must render as msg-interrupt, not be skipped
  ['isToolResultOnly', 'isLocalCommandStdout'].forEach(k => G(k, () => false));
  G('deriveRunning', () => false);
  ['clampOverflow', 'loadImages', 'updateBreadcrumb', 'saveNav', 'showStats', 'updateSpinner', 'updateSendBtn'].forEach(k => G(k, () => {}));
  G('renderMd', (t) => t); G('esc', (s) => String(s));
  // tickStreams reconciles the live text preview through these — set textContent so the
  // streamed text is inspectable (prod renderStreamMd rebuilds markdown in place).
  G('renderStreamMd', (el, t) => { el.textContent = t; });
  ['renderMermaidBlocks', 'renderKatexBlocks'].forEach(k => G(k, () => {}));
  G('renderToolNode', () => ''); G('summarizeToolInput', () => '');
  let apiResponse = { messages: [], hasMore: false };
  let apiHandler = async () => apiResponse;
  G('api', (...args) => apiHandler(...args));

  const ws = await import(path.join(ROOT, 'web/js/ws.js'));
  const { state } = await import(path.join(ROOT, 'web/js/state.js'));
  const hooks = w.__wsTest;
  if (!hooks) throw new Error('__wsTest hooks missing — is the __APEEK_TEST__ block present in ws.js?');

  const dumpDom = () => [...w.document.querySelector('.messages').children]
    .map(el => ({ cls: el.className, text: (el.textContent || '').trim() }));
  const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

  return {
    state,
    ws,
    hooks,
    window: w,
    document: w.document,
    dumpDom,
    tick,
    visualViewport,
    setApiResponse: (value) => { apiResponse = value; },
    setApiHandler: (handler) => { apiHandler = handler; },
  };
}

// Reset harness state to a fresh session view. mode: 'new' (optimistic bubble present)
// or 'existing' (history already rendered / empty). Returns nothing; mutates state+DOM.
export function resetSession(h, { sessionId = 's1', mode = 'existing', firstText = '' } = {}) {
  const { state, document } = h;
  state.WS_URL = 'wss://test'; state.KEY = 'k';
  state.appState = { session: mode === 'new' ? '__new__' : sessionId, device: 'D', project: { hash: '-h' } };
  state.wsSessionId = sessionId;
  state.wsAllMessages = []; state.wsMessageUuids = new Set(); state.wsRenderedCount = 0; state.wsMessageCount = 0;
  state._wsBuffer = null; state.wsRunning = mode === 'new';
  state._syncedOnce = null;
  state.wsLastTimestamp = ''; state._titleTier = 0;
  state.pendingSentMessages = mode === 'new' && firstText
    ? [{ id: 'sent-1', seq: 0, text: firstText, fullText: firstText, images: [], sentAt: Date.now() }] : [];
  document.querySelector('.messages').innerHTML = mode === 'new' && firstText
    ? '<div class="msg-user" id="sent-1" data-pending="1" data-anchor="sent-1">' + firstText + '</div>' : '';
}
