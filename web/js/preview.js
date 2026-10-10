import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { state } from './state.js';
import { backButtonHtml } from './components/back-button.js';
import { CLOSE_ICON_SVG } from './components/icons.js';
import { registerEdgeBackLayer } from './edge-back.js';
import { parsePreviewInput, parsePreviewTarget } from './preview-link.js';
import { PreviewTunnel } from './preview-transport.js';
import '../css/preview.css';

const connections = new Map();
const storageKey = 'baton-preview-ports';
const icons = {
  local: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
  browser: '<path d="M15 3h6v6m0-6L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
  delete: '<path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6m4-6v6"/>',
};
let overlay = null;
let selected = null;
let returnToList = false;
let navigationVersion = 0;
let restored = false;
let previousFocus = null;
let cancelClose = null;
const edgeBack = registerEdgeBackLayer({
  navigateBack: goBack,
  foregroundSelectors: ['#previewOverlay'],
  underlaySelectors: ['body > .top-bar', '#breadcrumb', '#content'],
  guardZIndex: 1201,
});

function actionButtons() {
  return [
    ['local', 'Open in app'],
    ['browser', 'Open in browser'],
    ['delete', 'Delete connection'],
  ].map(([action, label]) => `<button type="button" data-preview-action="${action}"
    aria-label="${label}" title="${label}" ${action !== 'delete' && !(window.isTauri || window.__TAURI_INTERNALS__) ? 'disabled' : ''}><svg viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.6" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true">${icons[action]}</svg></button>`).join('');
}

function deviceName(device) {
  return state.deviceDisplayNameMap[device] || window.__deviceDisplayNames?.[device] || device;
}

function getConnection(target, device) {
  const key = JSON.stringify([device, target.port]);
  let entry = connections.get(key);
  if (!entry) {
    entry = { device, target, version: 0, tunnel: null, pending: null, origin: '', listed: false, status: 'Not forwarded.' };
    connections.set(key, entry);
  } else {
    entry.target = target;
  }
  return entry;
}

function savedPorts() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch {
    return {};
  }
}

function restorePorts() {
  if (restored) return;
  restored = true;
  const saved = savedPorts()[state.SERVER];
  if (!Array.isArray(saved)) return;
  for (const record of saved) {
    const target = parsePreviewTarget(record?.url);
    if (target && typeof record.device === 'string') getConnection(target, record.device).listed = true;
  }
}

function savePorts() {
  const saved = savedPorts();
  saved[state.SERVER] = Array.from(connections.values()).filter(entry => entry.listed).map(entry => ({
    device: entry.device, url: entry.target.displayUrl,
  }));
  try { localStorage.setItem(storageKey, JSON.stringify(saved)); } catch {}
}

function ensureOverlay(device) {
  restorePorts();
  if (overlay) {
    cancelClose?.();
    overlay.dataset.device = device;
    return overlay;
  }
  previousFocus = document.activeElement;
  overlay = document.createElement('div');
  overlay.id = 'previewOverlay';
  overlay.dataset.device = device;
  overlay.innerHTML = `
    <section class="preview-panel" role="dialog" aria-modal="true" aria-label="Remote preview">
      <header class="preview-heading path-breadcrumb">
        ${backButtonHtml()}
        <strong class="preview-title"></strong>
        <div class="preview-actions" hidden>${actionButtons()}</div>
        <button class="preview-close file-modal-close" type="button" aria-label="Close preview" title="Close">
          ${CLOSE_ICON_SVG}
        </button>
      </header>
      <div class="preview-manager bottom-sheet-scroll">
        <form class="preview-form">
          <label for="previewAddress">Remote port</label>
          <div class="preview-input-row">
            <input id="previewAddress" class="modal-input" name="port" placeholder="5173" inputmode="numeric"
              pattern="[0-9]{1,5}" maxlength="5" autocomplete="off" required>
            <button type="submit">Add</button>
          </div>
          <p class="preview-form-error" role="alert" hidden></p>
        </form>
        <div class="preview-port-list" hidden>
          <div class="preview-list-labels"><span>Remote port</span><span>Local port</span></div>
          <div class="preview-connections"></div>
        </div>
      </div>
      <div class="preview-content" hidden>
        <p class="preview-status" role="status"></p>
        <iframe class="preview-frame" title="Remote preview page"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
          allow="clipboard-read; clipboard-write" hidden></iframe>
      </div>
    </section>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.back-button').addEventListener('click', goBack);
  overlay.querySelector('.preview-close').addEventListener('click', goBack);
  overlay.addEventListener('click', event => {
    if (event.target === overlay) goBack();
    const button = event.target.closest('[data-preview-action]');
    if (!button) return;
    const entry = button.closest('.preview-connection')?.previewConnection || selected;
    if (!entry) return;
    if (button.dataset.previewAction === 'local') void openInline(entry, !selected || returnToList);
    if (button.dataset.previewAction === 'browser') void openBrowser(entry);
    if (button.dataset.previewAction === 'delete') void deleteConnection(entry);
  });
  overlay.querySelector('.preview-form').addEventListener('submit', async event => {
    event.preventDefault();
    const view = event.currentTarget;
    const input = view.querySelector('#previewAddress');
    const error = view.querySelector('.preview-form-error');
    const button = view.querySelector('button[type="submit"]');
    if (button.disabled) return;
    const value = input.value.trim();
    const target = /^\d{1,5}$/.test(value) ? parsePreviewInput(value) : null;
    error.hidden = !!target;
    if (!target) {
      error.textContent = 'Enter a port from 1 to 65535.';
      return;
    }
    const entry = getConnection(target, view.closest('#previewOverlay').dataset.device);
    button.disabled = true;
    button.textContent = 'Checking…';
    try {
      const origin = await connect(entry);
      if (origin) {
        input.value = '';
        if (view.isConnected) input.focus();
      } else if (view.isConnected) {
        error.textContent = entry.status;
        error.hidden = false;
      }
    } finally {
      button.disabled = false;
      button.textContent = 'Add';
    }
  });
  return overlay;
}

function updateEntry(entry) {
  const connected = !!entry.origin && !entry.tunnel?.closed;
  if (entry.row) {
    entry.row.querySelector('.preview-remote').textContent = String(entry.target.port);
    entry.row.querySelector('.preview-local').textContent = connected
      ? new URL(entry.origin).port || '80' : '—';
    entry.row.querySelector('.preview-local').title = connected ? entry.origin : '';
  }
  if (selected !== entry || !overlay) return;
  const mapping = connected && Number(new URL(entry.origin).port) !== entry.target.port
    ? `Remote ${entry.target.port} → ${new URL(entry.origin).host}. ` : '';
  overlay.querySelector('.preview-status').textContent = mapping + entry.status;
  if (!connected) {
    const frame = overlay.querySelector('.preview-frame');
    frame.hidden = true;
    frame.removeAttribute('src');
  }
}

function renderList() {
  if (!overlay) return;
  const entries = Array.from(connections.values()).filter(entry => entry.listed && entry.device === overlay.dataset.device);
  for (const entry of entries) {
    if (!entry.row) {
      entry.row = document.createElement('div');
      entry.row.className = 'preview-connection';
      entry.row.previewConnection = entry;
      entry.row.innerHTML = `<div class="preview-endpoints">
        <code class="preview-remote"></code><code class="preview-local"></code>
      </div><div class="preview-actions">${actionButtons()}</div>`;
    }
    updateEntry(entry);
  }
  overlay.querySelector('.preview-connections').replaceChildren(...entries.map(entry => entry.row));
  overlay.querySelector('.preview-port-list').hidden = !entries.length;
}

function goBack() {
  cancelClose?.();
  navigationVersion++;
  if (selected && returnToList) {
    selected = null;
    showPreviewInput(overlay.dataset.device);
    return;
  }
  selected = null;
  edgeBack.deactivate();
  const view = overlay;
  if (!view) return;
  const panel = view.querySelector('.preview-panel');
  const animated = view.classList.contains('bottom-sheet-overlay')
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  view.classList.remove('open');
  let timer;
  function cleanup() {
    clearTimeout(timer);
    panel.removeEventListener('transitionend', finish);
    cancelClose = null;
  }
  function finish(event) {
    if (event && (event.target !== panel || event.propertyName !== 'transform')) return;
    cleanup();
    view.remove();
    if (overlay === view) overlay = null;
    previousFocus?.focus({ preventScroll: true });
  }
  cancelClose = cleanup;
  if (!animated) return finish();
  panel.addEventListener('transitionend', finish);
  timer = setTimeout(finish, 320);
}

async function wsUrl() {
  if (!(window.isTauri || window.__TAURI_INTERNALS__)) {
    throw new Error('Port forwarding requires the Baton desktop or mobile app.');
  }
  if (!state.KEY || !state.SERVER) throw new Error('Sign in before opening a preview.');
  const cached = state.WS_URL || localStorage.getItem('_wsurl');
  if (cached?.startsWith('wss://')) return cached;
  const response = await fetch(`${state.SERVER.replace(/\/$/, '')}/api/bridge/config`, {
    headers: { 'x-api-key': state.KEY }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Preview configuration failed: HTTP ${response.status}`);
  const config = await response.json();
  if (!config.wsUrl?.startsWith('wss://')) throw new Error('Server did not provide a WSS endpoint.');
  return config.wsUrl;
}

async function connect(entry) {
  if (entry.origin && !entry.tunnel?.closed) return entry.origin;
  if (entry.pending) return entry.pending;
  const version = ++entry.version;
  entry.origin = '';
  entry.status = 'Connecting…';
  entry.pending = (async () => {
    try {
      const endpoint = await wsUrl();
      if (entry.version !== version) return null;
      const tunnel = new PreviewTunnel({
        device: entry.device, target: entry.target, wsUrl: endpoint, key: state.KEY,
        onStatus(message) {
          if (entry.version !== version) return;
          entry.status = message;
          queueMicrotask(() => {
            if (entry.version !== version) return;
            if (tunnel.closed) entry.origin = '';
            updateEntry(entry);
          });
        },
        onTraffic() {
          if (entry.version !== version) return;
          entry.status = 'Connected.';
          updateEntry(entry);
        },
      });
      entry.tunnel = tunnel;
      const url = await tunnel.start();
      if (entry.version !== version) {
        await tunnel.close();
        return null;
      }
      entry.origin = new URL(url).origin;
      entry.listed = true;
      entry.status = 'Connected.';
      savePorts();
      renderList();
      return entry.origin;
    } catch (error) {
      if (entry.version === version) {
        entry.origin = '';
        entry.status = `Preview failed: ${error.message || error}`;
        await entry.tunnel?.close();
        if (entry.version === version) {
          entry.tunnel = null;
          if (!entry.listed) connections.delete(JSON.stringify([entry.device, entry.target.port]));
        }
      }
      return null;
    } finally {
      if (entry.version === version) {
        entry.pending = null;
        updateEntry(entry);
      }
    }
  })();
  updateEntry(entry);
  return entry.pending;
}

function localUrl(origin, target) {
  return `${origin}${target.pathname}${target.search}${target.hash}`;
}

async function openInline(entry, fromList) {
  const view = ensureOverlay(entry.device);
  const version = ++navigationVersion;
  selected = entry;
  returnToList = fromList;
  view.classList.remove('modal-overlay', 'bottom-sheet-overlay', 'open');
  view.querySelector('.preview-panel').classList.remove('modal-box', 'bottom-sheet-panel');
  view.querySelector('.preview-heading').classList.add('path-breadcrumb');
  view.querySelector('.back-button').hidden = false;
  view.querySelector('.preview-close').hidden = true;
  view.querySelector('.preview-title').textContent = `${deviceName(entry.device)} · ${entry.target.port}`;
  view.querySelector('.preview-panel').classList.add('preview-inline');
  view.querySelector('.preview-manager').hidden = true;
  view.querySelector('.preview-content').hidden = false;
  view.querySelector('.preview-heading .preview-actions').hidden = false;
  edgeBack.activate();
  const frame = view.querySelector('.preview-frame');
  const target = entry.target;
  frame.hidden = true;
  frame.removeAttribute('src');
  updateEntry(entry);
  const origin = await connect(entry);
  if (!origin || !overlay || selected !== entry || version !== navigationVersion) return;
  frame.src = localUrl(origin, target);
  frame.hidden = false;
  view.querySelector('.back-button').focus();
}

async function openBrowser(entry) {
  const target = entry.target;
  const origin = await connect(entry);
  if (!origin) return;
  try {
    const url = localUrl(origin, target);
    if (/Android/i.test(navigator.userAgent)) {
      await invoke('plugin:in-app-browser|open_chrome', { payload: { url, toolbarColor: '#161b22' } });
    } else {
      await openUrl(url);
    }
  } catch (error) {
    entry.status = `Could not open browser: ${error.message || error}`;
    updateEntry(entry);
  }
}

async function disconnect(entry) {
  entry.version++;
  const tunnel = entry.tunnel;
  entry.tunnel = null;
  entry.pending = null;
  entry.origin = '';
  entry.status = 'Forwarding stopped.';
  updateEntry(entry);
  await tunnel?.close();
}

async function deleteConnection(entry) {
  entry.listed = false;
  connections.delete(JSON.stringify([entry.device, entry.target.port]));
  savePorts();
  const closing = disconnect(entry);
  if (selected === entry) goBack();
  else renderList();
  await closing;
}

export function openPreviewLink(value, device) {
  const target = parsePreviewTarget(value);
  if (!target || !device) return false;
  ensureOverlay(device);
  const entry = getConnection(target, device);
  void openInline(entry, false);
  return true;
}

export function showPreviewInput(device) {
  if (!device) return;
  const view = ensureOverlay(device);
  navigationVersion++;
  selected = null;
  const opening = !view.classList.contains('bottom-sheet-overlay') || !view.classList.contains('open');
  view.classList.add('modal-overlay', 'bottom-sheet-overlay');
  view.querySelector('.preview-panel').classList.add('modal-box', 'bottom-sheet-panel');
  view.querySelector('.preview-heading').classList.remove('path-breadcrumb');
  view.querySelector('.back-button').hidden = true;
  view.querySelector('.preview-close').hidden = false;
  view.querySelector('.preview-title').textContent = `Remote preview · ${deviceName(device)}`;
  view.querySelector('.preview-panel').classList.remove('preview-inline');
  view.querySelector('.preview-manager').hidden = false;
  view.querySelector('.preview-content').hidden = true;
  view.querySelector('.preview-heading .preview-actions').hidden = true;
  view.querySelector('.preview-frame').removeAttribute('src');
  renderList();
  edgeBack.deactivate();
  if (opening) {
    view.classList.remove('open');
    void view.offsetWidth;
    view.classList.add('open');
  }
  const focusTarget = window.matchMedia('(max-width: 600px)').matches ? '.preview-close' : '#previewAddress';
  view.querySelector(focusTarget).focus({ preventScroll: true });
}

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !overlay) return;
  event.preventDefault();
  event.stopPropagation();
  goBack();
}, true);

function closeConnections() {
  returnToList = false;
  goBack();
  for (const entry of connections.values()) void disconnect(entry);
  connections.clear();
  restored = false;
}

window.closePreviewConnections = closeConnections;
window.addEventListener('pagehide', closeConnections);
