import '../css/terminal.css';
import { backButtonHtml } from './components/back-button.js';
import { setBreadcrumbItemsLoading } from './components/breadcrumb.js';
import { registerEdgeBackLayer } from './edge-back.js';
import { clearTerminalView } from './terminal-view-state.js';
import { attachTerminalKeybar } from './terminal-keybar.js';
import { showCenteredModal, hideCenteredModal } from './components/modal-viewport.js';
import { setButtonLoading } from './components/loading.js';

let view = null;
let retained = null;
const encoder = new TextEncoder();
const edgeBack = registerEdgeBackLayer({ navigateBack: () => closeProjectTerminal({ keepAlive: true }),
  foregroundSelectors: ['#projectTerminalPage'], guardZIndex: 902, foregroundZIndex: 900 });

function isTouchViewport() {
  return matchMedia('(pointer: coarse)').matches || document.documentElement.classList.contains('native-mobile');
}

function syncTerminalViewport(current) {
  const visible = window.visualViewport;
  if (current.viewportBaseWidth !== window.innerWidth) {
    current.viewportBaseWidth = window.innerWidth;
    current.viewportBaseHeight = window.innerHeight;
  }
  current.viewportBaseHeight = Math.max(current.viewportBaseHeight, window.innerHeight, visible?.height || 0);
  const keyboardNowOpen = !!(visible && isTouchViewport() && visible.height < current.viewportBaseHeight * 0.75);
  const keyboardClosed = current.keyboardOpen && !keyboardNowOpen;
  current.keyboardOpen = keyboardNowOpen;
  current.page.classList.toggle('keyboard-open', keyboardNowOpen);
  current.page.style.height = visible ? `${visible.height}px` : '';
  current.page.style.top = visible ? `${visible.offsetTop}px` : '';
  return keyboardClosed;
}

function decode(data) {
  return Uint8Array.from(atob(data), character => character.charCodeAt(0));
}

function disposeTerminalRuntime(previous) {
  hideCenteredModal(previous.modal);
  previous.generation++;
  clearTimeout(previous.reconnect);
  clearTimeout(previous.ackTimer);
  clearTimeout(previous.syncTimer);
  clearTimeout(previous.operationTimer);
  previous.socket?.close();
  previous.observer?.disconnect();
  for (const dispose of previous.listeners.splice(0)) dispose();
  previous.terminal?.dispose();
  previous.socket = null;
  previous.terminal = null;
  previous.reconnect = null;
  previous.reconnectNow = null;
}

function suspendProjectTerminal() {
  closeProjectTerminal({ preserveView: true });
}

function credentials() {
  return JSON.stringify([localStorage.getItem('_as'), localStorage.getItem('_ak')]);
}

function ownsRuntime(current) {
  return view === current || retained === current;
}

function releaseRetained() {
  if (!retained) return;
  const previous = retained;
  retained = null;
  clearTimeout(previous.keepAliveTimer);
  document.removeEventListener('visibilitychange', releaseHiddenTerminal);
  window.removeEventListener('offline', releaseRetained);
  window.removeEventListener('pagehide', suspendProjectTerminal);
  disposeTerminalRuntime(previous);
}

function releaseHiddenTerminal() {
  if (document.hidden) releaseRetained();
}

export function closeProjectTerminal({ preserveView = false, keepAlive = false } = {}) {
  releaseRetained();
  if (!view) return false;
  const previous = view;
  view = null;
  previous.mobileControls?.reset();
  if (!preserveView) clearTerminalView();
  edgeBack.deactivate();
  window.removeEventListener('pagehide', suspendProjectTerminal);
  previous.terminal?.blur();
  if (keepAlive && !document.hidden && previous.ready && !previous.busy && !previous.failure
    && previous.socket?.readyState === WebSocket.OPEN) {
    retained = previous;
    previous.menu.hidden = true;
    previous.selector.setAttribute('aria-expanded', 'false');
    hideCenteredModal(previous.modal);
    previous.focusAfterSync = false;
    previous.keepAliveTimer = setTimeout(releaseRetained, 60000);
    document.addEventListener('visibilitychange', releaseHiddenTerminal);
    window.addEventListener('offline', releaseRetained);
    window.addEventListener('pagehide', suspendProjectTerminal);
  } else disposeTerminalRuntime(previous);
  setBreadcrumbItemsLoading([previous.projectLabel], false);
  previous.page.remove();
  window.syncMobileViewport?.();
  previous.returnFocus?.isConnected && previous.returnFocus.focus({ preventScroll: true });
  return true;
}

export function openProjectTerminal({ device, projectHash, projectName }) {
  if (view?.device === device && view.projectHash === projectHash && view.credentials === credentials()) {
    if (view.terminal && !isTouchViewport()) view.terminal.focus();
    return view.loading;
  }
  if (retained?.device === device && retained.projectHash === projectHash && retained.credentials === credentials()
    && retained.ready && !retained.busy && retained.socket?.readyState === WebSocket.OPEN
    && Date.now() - retained.socket.lastAckAt < 30000) {
    const current = view = retained;
    retained = null;
    clearTimeout(current.keepAliveTimer);
    document.removeEventListener('visibilitychange', releaseHiddenTerminal);
    window.removeEventListener('offline', releaseRetained);
    current.returnFocus = document.activeElement;
    document.body.appendChild(current.page);
    window.syncMobileViewport?.();
    current.resume();
    edgeBack.activate();
    return current.writes;
  }
  closeProjectTerminal();
  const page = document.createElement('section');
  page.id = 'projectTerminalPage';
  page.className = 'project-terminal-page';
  page.setAttribute('aria-label', 'Project terminal');
  page.innerHTML = '<header class="path-breadcrumb project-terminal-header">' + backButtonHtml({ label: 'Back' })
    + '<div class="project-terminal-heading"><span class="path-breadcrumb-item project-terminal-project"></span></div>'
    + '<button class="project-terminal-action project-terminal-retry" type="button" hidden>Retry</button>'
    + '<button class="project-terminal-action project-terminal-selector" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="terminalMenu" disabled><span class="project-terminal-selection">Terminals</span>'
    + '<svg class="project-terminal-selector-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button></header>'
    + '<div class="project-terminal-status" role="status" hidden></div>'
    + '<main class="project-terminal-screen"></main>'
    + '<div class="project-terminal-menu" id="terminalMenu" role="dialog" aria-modal="true" aria-labelledby="terminalMenuTitle" hidden>'
    + '<div class="project-terminal-menu-panel"><div class="project-terminal-menu-heading"><span id="terminalMenuTitle">Terminals</span><span class="project-terminal-count"></span>'
    + '<button class="project-terminal-add" type="button" aria-label="New terminal" title="New terminal">＋</button></div><div class="project-terminal-list"></div></div></div>'
    + '<div class="modal-overlay project-terminal-confirm" style="display:none" role="dialog" aria-modal="true" aria-labelledby="terminalCloseTitle">'
    + '<div class="modal-box"><div class="modal-title" id="terminalCloseTitle">Close terminal?</div>'
    + '<div class="modal-desc">This stops the terminal and its running process for all connected devices.</div>'
    + '<div class="modal-error" role="alert"></div>'
    + '<div class="modal-actions"><button class="modal-btn cancel" type="button">Cancel</button>'
    + '<button class="modal-btn confirm danger" type="button">Close terminal</button></div></div></div>';
  const returnFocus = document.activeElement;
  document.body.appendChild(page);
  window.syncMobileViewport?.();
  const projectLabel = page.querySelector('.project-terminal-project');
  projectLabel.textContent = projectName || 'Terminal';
  projectLabel.title = projectName || 'Terminal';
  const selectionKey = `terminal-selection:${JSON.stringify([localStorage.getItem('_as'), device, projectHash])}`;
  let selection;
  try { selection = sessionStorage.getItem(selectionKey); } catch {}
  const current = view = { page, device, projectHash, selectionKey, returnFocus, credentials: credentials(), listeners: [],
    ready: false, exited: false, generation: 0, queuedBytes: 0, ackBytes: 0, lastAck: 0,
    sessions: [], limit: 5, sessionId: selection, busy: null,
    projectLabel, status: page.querySelector('.project-terminal-status'),
    selector: page.querySelector('.project-terminal-selector'), retry: page.querySelector('.project-terminal-retry'),
    menu: page.querySelector('.project-terminal-menu'), list: page.querySelector('.project-terminal-list'),
    add: page.querySelector('.project-terminal-add'),
    modal: page.querySelector('.project-terminal-confirm'), writes: Promise.resolve() };
  syncTerminalViewport(current);
  page.querySelector('.back-button').addEventListener('click', () => closeProjectTerminal({ keepAlive: true }));
  current.retry.addEventListener('click', () => {
    if (current.reconnectNow) current.reconnectNow();
    else current.loading = loadTerminalRuntime(current);
  });
  window.addEventListener('pagehide', suspendProjectTerminal);
  edgeBack.activate();
  current.loading = loadTerminalRuntime(current);
  return current.loading;
}

async function loadTerminalRuntime(current) {
  current.retry.hidden = true;
  current.status.hidden = true;
  current.status.dataset.state = 'loading';
  current.status.textContent = '';
  current.page.setAttribute('aria-busy', 'true');
  setBreadcrumbItemsLoading([current.projectLabel], true);
  try {
    const runtime = await import('./terminal-runtime.js');
    if (view !== current) return;
    initializeProjectTerminal(current, runtime);
  } catch (error) {
    if (view !== current) return;
    disposeTerminalRuntime(current);
    current.page.querySelector('.project-terminal-screen').replaceChildren();
    current.selector.disabled = true;
    current.add.disabled = true;
    current.menu.hidden = true;
    setBreadcrumbItemsLoading([current.projectLabel], false);
    current.status.hidden = false;
    current.status.dataset.state = 'error';
    current.status.textContent = 'Unable to load terminal. Check your connection and retry.';
    current.retry.hidden = false;
    console.error('Terminal initialization failed', error);
  } finally {
    current.page.removeAttribute('aria-busy');
  }
}

function initializeProjectTerminal(current, { Terminal, FitAddon, RemoteTerminalSocket }) {
  const { page, device, projectHash, selectionKey } = current;
  const terminal = current.terminal = new Terminal({ cursorBlink: true, fontSize: 14, scrollback: 1000, allowProposedApi: true,
    fontFamily: 'Menlo, Monaco, Consolas, monospace', disableStdin: true,
    scrollbar: { width: 6 },
    theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#e6edf3',
      scrollbarSliderBackground: '#3a4049', scrollbarSliderHoverBackground: '#4a5059',
      scrollbarSliderActiveBackground: '#4a5059', overviewRulerBorder: '#00000000' } });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  const screen = page.querySelector('.project-terminal-screen');
  terminal.open(screen);
  const listen = (target, name, callback, options) => {
    target.addEventListener(name, callback, options);
    current.listeners.push(() => target.removeEventListener(name, callback, options));
  };
  // Bottom-anchor only once content fills the screen so the fit remainder moves above row one.
  const syncFill = () => {
    const buffer = terminal.buffer.active;
    screen.classList.toggle('fills', buffer.type === 'alternate' || buffer.baseY > 0 || buffer.cursorY >= terminal.rows - 1);
  };

  let keyboardTap = null;
  let handledKeyboardClick = false;
  const clearKeyboardTap = () => { keyboardTap = null; handledKeyboardClick = false; };
  const consumeKeyboardTap = event => { event.preventDefault(); event.stopImmediatePropagation(); };
  if (window.__BATON_NATIVE_MOBILE__) {
    current.mobileControls = attachTerminalKeybar({ page, screen, terminal,
      send: data => input(encoder.encode(data)), showError: text => status(text, 'error'),
      canInput: () => view === current && !terminal.options.disableStdin && !document.hidden
        && current.socket?.readyState === WebSocket.OPEN && current.menu.hidden && current.modal.style.display !== 'flex',
      onJoystickStart: clearKeyboardTap });
    current.listeners.push(() => { current.mobileControls.dispose(); current.mobileControls = null; });
  }
  listen(page, 'pointerdown', event => {
    clearKeyboardTap();
    if (event.pointerType !== 'touch' || event.isPrimary === false
      || event.target.closest?.('button, a, input, textarea, select, [contenteditable], .xterm-scrollbar, .project-terminal-keybar')) return;
    const dismiss = document.activeElement === terminal.textarea && current.keyboardOpen;
    if (!dismiss && !screen.contains(event.target)) return;
    keyboardTap = { id: event.pointerId, x: event.clientX, y: event.clientY, dismiss };
  }, true);
  listen(page, 'pointermove', event => {
    if (keyboardTap?.id === event.pointerId
      && Math.hypot(event.clientX - keyboardTap.x, event.clientY - keyboardTap.y) > 8) keyboardTap = null;
  }, true);
  listen(page, 'pointerup', event => {
    const tap = keyboardTap;
    keyboardTap = null;
    if (!tap || tap.id !== event.pointerId || (tap.dismiss && document.activeElement !== terminal.textarea)
      || Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 8) return;
    if (!tap.dismiss) {
      keyboardTap = { ...tap, released: true };
      return;
    }
    handledKeyboardClick = true;
    terminal.blur();
    consumeKeyboardTap(event);
  }, true);
  listen(page, 'touchend', event => {
    if (event.touches.length || !keyboardTap?.released) return;
    keyboardTap = null;
    handledKeyboardClick = true;
    if (terminal.options.disableStdin) return;
    if (document.activeElement === terminal.textarea) terminal.blur();
    terminal.focus();
  }, true);
  for (const name of ['mousedown', 'mouseup', 'click']) {
    listen(page, name, event => {
      if (!handledKeyboardClick && !keyboardTap) return;
      if (name === 'click' && keyboardTap?.released) {
        clearKeyboardTap();
        if (terminal.options.disableStdin) return;
        if (document.activeElement === terminal.textarea) terminal.blur();
        terminal.focus();
        return;
      }
      consumeKeyboardTap(event);
      if (name === 'click') clearKeyboardTap();
    }, true);
  }
  listen(page, 'pointercancel', clearKeyboardTap, true);
  listen(page, 'contextmenu', clearKeyboardTap, true);

  let resizeAnchor = null;
  let resizeFrame = 0;
  let resizeFollowBottom = false;
  const clearResizeAnchor = () => {
    window.cancelAnimationFrame(resizeFrame);
    resizeAnchor?.dispose();
    resizeAnchor = null;
    resizeFollowBottom = false;
  };
  current.listeners.push(clearResizeAnchor);
  function resizeTerminal(cols, rows, followBottom = false) {
    followBottom = (followBottom || resizeFollowBottom) && terminal.buffer.active.type === 'normal';
    if (followBottom) clearResizeAnchor();
    resizeFollowBottom = followBottom;
    const buffer = terminal.buffer.active;
    const following = followBottom || (!resizeAnchor && buffer.viewportY === buffer.baseY);
    if (!following && !resizeAnchor) resizeAnchor = terminal.registerMarker(buffer.viewportY - buffer.baseY - buffer.cursorY);
    terminal.resize(cols, rows);
    syncFill();
    const bounds = screen.querySelector('.xterm-screen')?.getBoundingClientRect();
    if (bounds) {
      terminal.textarea.style.top = `${terminal.buffer.active.cursorY * bounds.height / terminal.rows}px`;
      terminal.textarea.style.left = `${Math.min(terminal.cols - 1, terminal.buffer.active.cursorX) * bounds.width / terminal.cols}px`;
    }
    if (resizeAnchor || following) {
      const resizedViewport = terminal.buffer.active.viewportY;
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        if (followBottom && terminal.buffer.active.type === 'normal') {
          terminal.scrollLines(terminal.buffer.active.length);
          terminal.refresh(0, terminal.rows - 1);
          screen.scrollTop = 0;
        } else if (!resizeAnchor?.isDisposed && terminal.buffer.active.viewportY === resizedViewport) {
          const target = resizeAnchor?.line ?? (following ? terminal.buffer.active.baseY : resizedViewport);
          terminal.scrollLines(-terminal.buffer.active.length);
          terminal.scrollToLine(target);
        }
        clearResizeAnchor();
      });
    }
    return following;
  }

  function status(text, state = 'connected') {
    setBreadcrumbItemsLoading([current.projectLabel], state === 'connecting' || state === 'syncing');
    current.status.textContent = text;
    current.status.dataset.state = state;
    current.status.hidden = state !== 'error' && state !== 'warning';
  }

  function rememberSelection() {
    try {
      if (current.sessionId) sessionStorage.setItem(selectionKey, current.sessionId);
      else sessionStorage.removeItem(selectionKey);
    } catch {}
  }

  function controls() {
    const disabled = !current.ready || !!current.busy;
    const selected = current.sessions.find(session => session.id === current.sessionId);
    current.selector.disabled = disabled;
    current.selector.title = 'Switch or manage terminals';
    page.querySelector('.project-terminal-selection').textContent = selected?.name || current.sessionName || 'Terminals';
    page.querySelector('.project-terminal-count').textContent = `${current.sessions.length}/${current.limit}`;
    current.add.disabled = disabled || current.sessions.length >= current.limit;
    current.add.title = current.sessions.length >= current.limit ? 'Maximum 5 terminals' : 'New terminal';
    terminal.options.disableStdin = !current.ready || !!current.busy || current.exited || !current.sessionId;
    current.mobileControls?.sync();
    const focused = document.activeElement;
    const focusId = current.list.contains(focused) ? focused.dataset.sessionId : null;
    const focusAction = focused?.dataset.action;
    current.list.replaceChildren();
    for (const session of current.sessions) {
      const row = document.createElement('div');
      row.className = 'project-terminal-row';
      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'project-terminal-option';
      select.dataset.action = 'select';
      select.dataset.sessionId = session.id;
      select.disabled = disabled;
      select.setAttribute('aria-current', session.id === current.sessionId ? 'true' : 'false');
      const check = document.createElement('span');
      check.className = 'project-terminal-check';
      check.textContent = session.id === current.sessionId ? '✓' : '';
      check.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span');
      name.textContent = session.name;
      select.append(check, name);
      if (session.exited) {
        const exited = document.createElement('span');
        exited.className = 'project-terminal-exited';
        exited.textContent = 'Exited';
        select.append(exited);
      }
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'project-terminal-close';
      close.dataset.action = 'close';
      close.dataset.sessionId = session.id;
      close.disabled = disabled;
      close.setAttribute('aria-label', `Close ${session.name}`);
      close.title = `Close ${session.name}`;
      close.textContent = '×';
      row.append(select, close);
      current.list.appendChild(row);
    }
    if (focusId && !current.menu.hidden) {
      const replacement = [...current.list.querySelectorAll('button')].find(button => button.dataset.sessionId === focusId && button.dataset.action === focusAction && !button.disabled);
      (replacement || current.add).focus({ preventScroll: true });
    }
  }

  function settledStatus() {
    if (!current.ready || current.busy) return;
    const text = current.exited ? 'Shell exited · Close this terminal or create a new one'
      : current.historyTruncated ? 'Recent history omitted' : '';
    status(text, text ? 'warning' : 'connected');
    if (view === current && current.focusAfterSync && current.sessionId && !current.exited && matchMedia('(pointer: fine)').matches) terminal.focus();
    current.focusAfterSync = false;
    if (!document.hidden) useLocalSize();
  }

  function menu(open) {
    current.mobileControls?.reset();
    current.menu.hidden = !open;
    current.selector.setAttribute('aria-expanded', String(open));
    if (open) {
      current.menu.style.setProperty('--terminal-menu-top', `${page.querySelector('header').getBoundingClientRect().height + 4}px`);
      terminal.blur();
      (current.list.querySelector('[aria-current="true"]') || current.add).focus({ preventScroll: true });
    } else current.selector.focus({ preventScroll: true });
  }

  function operate(type, sessionId) {
    if (!current.ready || current.busy) return;
    menu(false);
    const requestId = crypto.randomUUID();
    current.busy = requestId;
    current.focusAfterSync = type !== 'close_session' || sessionId === current.sessionId;
    controls();
    status('Updating terminals…', 'syncing');
    if (!send({ type, requestId, ...(sessionId ? { sessionId } : {}), ...(type === 'create_session' ? proposedSize() : {}) })) {
      fail('Terminal connection is unavailable', true);
      return;
    }
    current.operationTimer = setTimeout(() => {
      fail('Terminal operation result unknown; reconnecting without repeating it', true);
      current.socket?.close();
    }, 15000);
  }

  function proposedSize() {
    const size = fit.proposeDimensions();
    return { cols: Math.min(400, Math.max(20, size?.cols || 80)), rows: Math.min(200, Math.max(5, size?.rows || 24)) };
  }

  function send(message) {
    if (!ownsRuntime(current) || current.socket?.readyState !== WebSocket.OPEN) return false;
    current.socket.send(JSON.stringify({ sessionId: current.sessionId, ...message, epoch: current.epoch }));
    return true;
  }

  function useLocalSize({ followBottom = false } = {}) {
    if (view !== current) return;
    if (!current.ready || current.exited || !current.sessionId || current.busy || !current.menu.hidden) return;
    const size = proposedSize();
    if ((terminal.cols !== size.cols || terminal.rows !== size.rows)
      && (current.requestedSize?.cols !== size.cols || current.requestedSize?.rows !== size.rows)) {
      current.requestedSize = { ...size, followBottom: followBottom || !!current.requestedSize?.followBottom };
      send({ type: 'resize', ...size });
    } else if (followBottom && current.requestedSize) current.requestedSize.followBottom = true;
  }

  function input(bytes) {
    if (!current.ready || current.exited || !current.sessionId || current.busy || view !== current) return;
    if (bytes.length > 64 * 1024) return status('Paste exceeds 64 KiB; nothing sent', 'error');
    clearResizeAnchor();
    useLocalSize();
    for (let offset = 0; offset < bytes.length; offset += 4096) {
      const data = btoa(String.fromCharCode(...bytes.subarray(offset, offset + 4096)));
      if (!send({ type: 'input', data })) break;
    }
  }

  function acknowledge() {
    clearTimeout(current.ackTimer);
    current.ackTimer = null;
    if (!current.lastAck) return;
    send({ type: 'render_ack', eventSeq: current.lastAck });
    current.lastAck = 0;
    current.ackBytes = 0;
  }

  let submittedMessages = Promise.resolve();
  const pendingWrites = new Set();
  current.listeners.push(() => {
    for (const complete of pendingWrites) complete();
  });
  function write(data) {
    return new Promise((resolve, reject) => {
      const complete = () => { pendingWrites.delete(complete); syncFill(); resolve(); };
      pendingWrites.add(complete);
      try { terminal.write(data, complete); }
      catch (error) { pendingWrites.delete(complete); reject(error); }
    });
  }

  function fail(message, reconnect = false) {
    if (retained === current) { releaseRetained(); return; }
    if (view !== current) return;
    current.ready = false;
    terminal.options.disableStdin = true;
    clearTimeout(current.operationTimer);
    current.busy = null;
    menu(false);
    controls();
    current.failure = message;
    clearTimeout(current.syncTimer);
    closeConfirmation();
    if (reconnect && !current.reconnect && (current.reconnectCount || 0) < 5) {
      current.reconnectCount = (current.reconnectCount || 0) + 1;
      current.reconnect = setTimeout(() => { current.reconnect = null; connect(); }, Math.min(15000, current.reconnectCount * 3000));
    }
    current.retry.hidden = false;
    status(message, 'error');
  }

  async function receive(message, generation) {
    if (!ownsRuntime(current) || generation !== current.generation || current.failure) return;
    if (message.type === 'sessions') {
      if (!Array.isArray(message.sessions) || message.sessions.length > 5 || message.limit !== 5
        || message.sessions.some(session => typeof session.id !== 'string' || typeof session.name !== 'string')) throw new Error('Invalid terminal list');
      current.sessions = message.sessions;
      if (current.closingId && !current.busy && !current.sessions.some(session => session.id === current.closingId)) closeConfirmation();
      controls();
    } else if (message.type === 'session_result') {
      if (message.requestId !== current.busy) return;
      clearTimeout(current.operationTimer);
      current.busy = null;
      controls();
      if (current.closingId) {
        if (message.error) {
          setButtonLoading(current.modal.querySelector('.confirm'));
          current.modal.querySelector('.cancel').disabled = false;
          current.modal.querySelector('.modal-error').textContent = message.error;
        } else closeConfirmation();
      }
      if (message.error) { current.focusAfterSync = false; status(message.error, 'error'); }
      else settledStatus();
    } else if (message.type === 'ready') {
      if (!current.sessions.some(session => session.id === message.sessionId)) throw new Error('Terminal list out of sync. Update Bridge and reconnect.');
      clearTimeout(current.ackTimer);
      current.ackTimer = null;
      current.lastAck = 0;
      current.ackBytes = 0;
      current.requestedSize = null;
      current.ready = false;
      current.exited = message.exited;
      current.epoch = message.epoch;
      current.sessionId = message.sessionId;
      current.sessionName = message.name;
      rememberSelection();
      current.snapshotId = message.snapshotId;
      current.snapshotIndex = 0;
      current.snapshotBytes = 0;
      current.snapshotTotal = message.snapshotBytes;
      current.snapshotChunks = message.snapshotChunks;
      current.historyTruncated = message.historyTruncated;
      terminal.options.disableStdin = true;
      clearResizeAnchor();
      terminal.reset();
      terminal.resize(message.cols, message.rows);
      syncFill();
      current.page.dataset.sessionId = message.sessionId;
      current.page.dataset.epoch = message.epoch;
      current.page.dataset.cwd = message.cwd;
      controls();
      status('Syncing screen…', 'syncing');
      clearTimeout(current.syncTimer);
      current.syncTimer = setTimeout(() => { fail('Screen sync timed out; reconnect to restore'); current.socket?.close(); }, 60000);
    } else if (message.type === 'snapshot') {
      if (message.epoch !== current.epoch || message.snapshotId !== current.snapshotId || message.index !== current.snapshotIndex) throw new Error('Snapshot sequence mismatch');
      const bytes = decode(message.data);
      current.snapshotBytes += bytes.length;
      if (current.snapshotBytes > current.snapshotTotal || current.snapshotTotal > 4 * 1024 * 1024) throw new Error('Snapshot exceeds limit');
      await write(bytes);
      if (!ownsRuntime(current) || generation !== current.generation) return;
      current.snapshotIndex++;
      send({ type: 'render_ack', eventSeq: message.eventSeq, snapshotId: message.snapshotId, index: message.index });
    } else if (message.type === 'synced') {
      if (message.epoch !== current.epoch || message.snapshotId !== current.snapshotId
        || current.snapshotBytes !== current.snapshotTotal || current.snapshotIndex !== current.snapshotChunks) throw new Error('Incomplete terminal snapshot');
      clearTimeout(current.syncTimer);
      current.ready = true;
      current.reconnectCount = 0;
      current.retry.hidden = true;
      controls();
      settledStatus();
    } else if (message.type === 'output') {
      if (message.epoch !== current.epoch) throw new Error('Terminal generation mismatch');
      const bytes = decode(message.data);
      await write(bytes);
      if (!ownsRuntime(current) || generation !== current.generation) return;
      current.lastAck = message.eventSeq;
      current.ackBytes += bytes.length;
      if (current.ackBytes >= 16384) acknowledge();
      else if (!current.ackTimer) current.ackTimer = setTimeout(acknowledge, 100);
    } else if (message.type === 'resized') {
      if (message.epoch !== current.epoch) return;
      const localResize = current.requestedSize?.cols === message.cols && current.requestedSize?.rows === message.rows;
      const followBottom = localResize && current.requestedSize.followBottom;
      if (localResize) current.requestedSize = null;
      const following = resizeTerminal(message.cols, message.rows, followBottom);
      if (localResize && following && terminal.buffer.active.type === 'normal'
        && document.hasFocus() && document.activeElement === terminal.textarea) {
        terminal.scrollToBottom();
        screen.scrollTop = 0;
      }
    } else if (message.type === 'exit') {
      current.exited = true;
      terminal.options.disableStdin = true;
      current.mobileControls?.sync();
      settledStatus();
    } else if (message.type === 'error') {
      if (message.fatal) { fail(message.message); current.socket?.close(); }
      else status(message.message, 'error');
    }
  }

  function connect() {
    if (view !== current) return;
    current.generation++;
    const generation = current.generation;
    clearTimeout(current.reconnect);
    clearTimeout(current.ackTimer);
    current.reconnect = null;
    current.ackTimer = null;
    current.lastAck = 0;
    current.ackBytes = 0;
    current.ready = false;
    current.busy = null;
    current.failure = null;
    terminal.options.disableStdin = true;
    controls();
    current.retry.hidden = true;
    current.socket?.close();
    status('Connecting…', 'connecting');
    const initialOpen = { sessionId: current.sessionId, ...proposedSize() };
    const socket = current.socket = new RemoteTerminalSocket(device, { direct: true, projectHash, initialOpen });
    socket.addEventListener('open', () => {
      if (view === current && generation === current.generation && !socket.initialOpenAccepted) socket.send(JSON.stringify({ type: 'open', ...initialOpen }));
    });
    socket.addEventListener('message', event => {
      if (!ownsRuntime(current) || generation !== current.generation) return;
      const message = JSON.parse(event.data);
      const size = message.data?.length || 0;
      if (current.queuedBytes + size > 1024 * 1024) { fail('Terminal display is behind; reconnect to restore'); socket.close(); return; }
      current.queuedBytes += size;
      const previousWrites = current.writes;
      let completion;
      const submitted = submittedMessages.then(async () => {
        if (message.type !== 'output') await previousWrites;
        completion = receive(message, generation);
      });
      const completed = submitted.then(() => completion).catch(error => {
        if (generation === current.generation) { fail(error.message); socket.close(); }
      }).finally(() => { current.queuedBytes -= size; });
      submittedMessages = message.type === 'output' ? submitted : completed;
      current.writes = Promise.all([previousWrites, completed]).then(() => {});
    });
    socket.addEventListener('error', event => {
      if (ownsRuntime(current) && generation === current.generation) {
        const message = event.data || 'Terminal connection failed';
        fail(message, !/update|directory|maximum|invalid|permission|unsupported/i.test(message));
      }
    });
    socket.addEventListener('close', () => {
      if (ownsRuntime(current) && generation === current.generation && !current.failure) fail('Disconnected · reconnecting; background shell is retained', true);
    });
  }

  function closeConfirmation() {
    if (current.closingId && current.busy) return;
    setButtonLoading(current.modal.querySelector('.confirm'));
    current.modal.querySelector('.cancel').disabled = false;
    hideCenteredModal(current.modal);
    current.closingId = null;
    current.selector.focus({ preventScroll: true });
  }

  current.reconnectNow = () => { current.reconnectCount = 0; connect(); };
  listen(current.selector, 'click', () => menu(current.menu.hidden));
  listen(current.add, 'click', () => operate('create_session'));
  listen(current.menu, 'click', event => { if (event.target === current.menu) menu(false); });
  listen(current.list, 'click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    const session = current.sessions.find(candidate => candidate.id === button.dataset.sessionId);
    if (!session) return;
    if (button.dataset.action === 'select') {
      if (session.id === current.sessionId) menu(false);
      else operate('select_session', session.id);
    } else {
      menu(false);
      current.closingId = session.id;
      current.modal.querySelector('.modal-error').textContent = '';
      const restart = current.sessions.length === 1;
      current.modal.querySelector('.modal-title').textContent = `${restart ? 'Restart' : 'Close'} ${session.name}?`;
      current.modal.querySelector('.modal-desc').textContent = restart
        ? 'This stops the current process and starts a new terminal for all connected devices.'
        : 'This stops the terminal and its running process for all connected devices.';
      current.modal.querySelector('.confirm').textContent = restart ? 'Restart terminal' : 'Close terminal';
      showCenteredModal(current.modal);
      current.modal.querySelector('.cancel').focus({ preventScroll: true });
    }
  });
  listen(current.modal.querySelector('.cancel'), 'click', closeConfirmation);
  listen(current.modal, 'click', event => { if (event.target === current.modal) closeConfirmation(); });
  listen(current.modal.querySelector('.confirm'), 'click', () => {
    const sessionId = current.closingId;
    if (!sessionId || !current.ready || current.busy) return;
    setButtonLoading(current.modal.querySelector('.confirm'), current.sessions.length === 1 ? 'Restarting' : 'Closing');
    current.modal.querySelector('.cancel').disabled = true;
    current.modal.querySelector('.modal-error').textContent = '';
    operate('close_session', sessionId);
  });
  listen(current.menu, 'keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); menu(false); }
    if (event.key === 'Tab' || event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const buttons = [...current.menu.querySelectorAll('button:not(:disabled)')];
      if (!buttons.length) return;
      event.preventDefault();
      event.stopPropagation();
      const direction = event.shiftKey || event.key === 'ArrowUp' ? -1 : 1;
      buttons[(buttons.indexOf(document.activeElement) + direction + buttons.length) % buttons.length].focus();
    }
  });
  listen(current.modal, 'keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeConfirmation(); }
    if (event.key === 'Tab') {
      event.preventDefault();
      const buttons = current.modal.querySelectorAll('button:not(:disabled)');
      if (!buttons.length) return;
      (document.activeElement === buttons[0] ? buttons[1] : buttons[0]).focus();
    }
  });

  terminal.onData(data => { if (!current.mobileControls?.handleData(data)) input(encoder.encode(data)); });
  terminal.onBinary(data => input(Uint8Array.from(data, character => character.charCodeAt(0) & 255)));
  for (const identifier of [{ final: 'n' }, { prefix: '?', final: 'n' }, { final: 'c' },
    { prefix: '>', final: 'c' }, { prefix: '=', final: 'c' }, { intermediates: '$', final: 'p' },
    { prefix: '?', intermediates: '$', final: 'p' }]) terminal.parser.registerCsiHandler(identifier, () => true);
  terminal.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, () => true);
  for (const code of [10, 11, 12]) terminal.parser.registerOscHandler(code, data => data === '?');

  const touchViewport = isTouchViewport();
  function viewport() {
    if (view !== current) return;
    const keyboardWasOpen = current.keyboardOpen;
    const keyboardClosed = syncTerminalViewport(current);
    const keyboardOpened = window.__BATON_NATIVE_MOBILE__ && !keyboardWasOpen && current.keyboardOpen;
    const followBottom = (keyboardOpened || keyboardClosed) && terminal.buffer.active.type === 'normal';
    current.menu.style.setProperty('--terminal-menu-top', `${page.querySelector('header').getBoundingClientRect().height + 4}px`);
    if (keyboardClosed) current.mobileControls?.reset();
    if (keyboardClosed || followBottom) clearResizeAnchor();
    if (followBottom) {
      terminal.scrollToBottom();
      screen.scrollTop = 0;
    }
    if (!document.hidden) useLocalSize({ followBottom });
  }
  current.observer = new ResizeObserver(() => {
    if (!document.hidden) useLocalSize();
  });
  current.observer.observe(screen);
  listen(screen, 'pointerdown', event => { if (event.pointerType !== 'touch') useLocalSize(); });
  listen(terminal.textarea, 'focus', viewport);
  listen(window, 'focus', useLocalSize);
  listen(document, 'visibilitychange', () => { if (!document.hidden) useLocalSize(); });
  if (window.visualViewport) {
    listen(window.visualViewport, 'resize', viewport);
    listen(window.visualViewport, 'scroll', viewport);
  }
  current.resume = () => {
    clearKeyboardTap();
    clearResizeAnchor();
    controls();
    viewport();
    terminal.refresh(0, terminal.rows - 1);
    if (!touchViewport) terminal.focus();
  };
  viewport();
  connect();
  if (!touchViewport) terminal.focus();
}

Object.assign(window, { closeProjectTerminal: options => closeProjectTerminal({ keepAlive: true, ...options }),
  deactivateProjectTerminal: closeProjectTerminal });
