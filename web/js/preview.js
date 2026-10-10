import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { state } from './state.js';
import { CLOSE_ICON_SVG } from './components/icons.js';
import { setBreadcrumbItemsLoading } from './components/breadcrumb.js';
import { loadingSpinner } from './components/loading.js';
import { openBrowserPage } from './browser/page.js';
import { normalizeBrowserAddress } from './browser/address.js';
import { parsePreviewInput, parsePreviewTarget } from './preview-link.js';
import { PreviewTunnel } from './preview-transport.js';
import '../css/preview.css';
import '../css/loading.css';

const connections = new Map();
const connectionRefreshes = new Map();
const storageKey = 'baton-preview-ports';
const icons = {
  local: '<path d="M2 12c2.5-4.5 5.8-7 10-7s7.5 2.5 10 7c-2.5 4.5-5.8 7-10 7S4.5 16.5 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  browser: '<path d="M15 3h6v6m0-6L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
  delete: '<path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6m4-6v6"/>',
};
let overlay = null;
let selected = null;
let browserView = null;
let cachedBrowser = null;
let navigationVersion = 0;
let restored = false;
let previousFocus = null;
let cancelClose = null;
let prewarmedEntry = null;
let prewarmVersion = 0;

function adoptPrewarm(entry) {
  prewarmVersion++;
  if (prewarmedEntry && prewarmedEntry !== entry) void cancelPreviewPrewarm();
  if (prewarmedEntry === entry) {
    prewarmedEntry = null;
  }
  entry.speculative = false;
}

async function releasePrewarm() {
  const entry = prewarmedEntry;
  prewarmedEntry = null;
  if (!entry || !entry.speculative) return;
  const closing = disconnect(entry);
  entry.closing = closing;
  try {
    await closing;
  } finally {
    if (entry.closing === closing) entry.closing = null;
    const key = JSON.stringify([entry.device, entry.target.port]);
    if (entry.speculative && !entry.listed && connections.get(key) === entry) connections.delete(key);
  }
}

export function cancelPreviewPrewarm() {
  prewarmVersion++;
  return releasePrewarm();
}

export async function prewarmPreviewLink(value, device) {
  const target = parsePreviewTarget(value);
  if (!target || !device || device !== state.appState.device || !state.appState.session
    || document.hidden || browserView || overlay || !state.KEY
    || !(window.isTauri || window.__TAURI_INTERNALS__)) return;
  const key = JSON.stringify([device, target.port]);
  const existing = connections.get(key);
  if (existing && (existing.pending || (existing.origin && !existing.tunnel?.closed))) return;
  const version = ++prewarmVersion;
  await releasePrewarm();
  if (version !== prewarmVersion || device !== state.appState.device || document.hidden) return;
  if (Array.from(connections.values()).filter(entry =>
    entry.pending || (entry.tunnel && !entry.tunnel.closed)).length >= 3) return;
  restorePorts();
  const entry = getConnection(target, device);
  entry.speculative = true;
  prewarmedEntry = entry;
  const origin = await connect(entry, { speculative: true });
  if (!origin && prewarmedEntry === entry) {
    prewarmedEntry = null;
  }
}

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

function portNotListening(entry, status = entry.status) {
  const message = `Port ${entry.target.port} is not listening on ${entry.device}`;
  return status === message || status === `Preview failed: ${message}`;
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
      <header class="preview-heading">
        <div class="preview-heading-title">
          <strong class="preview-title">Remote preview</strong>
          <button type="button" class="path-breadcrumb-item preview-device" title="Refresh port connections"></button>
        </div>
        <button class="preview-close file-modal-close" type="button" aria-label="Close preview" title="Close">
          ${CLOSE_ICON_SVG}
        </button>
      </header>
      <div class="preview-manager bottom-sheet-scroll">
        <form class="preview-form">
          <label for="previewAddress">Remote port</label>
          <div class="preview-input-row">
            <input id="previewAddress" class="modal-input" name="port" placeholder="3000" inputmode="numeric"
              pattern="[0-9]{1,5}" maxlength="5" autocomplete="off" required>
            <button type="submit" class="preview-add" aria-label="Add port">
              <span class="preview-add-label">Add</span>
              <span class="preview-add-spinner">${loadingSpinner({ size: 'small', label: 'Connecting port' })}</span>
            </button>
          </div>
          <p class="preview-form-error" role="alert" hidden></p>
        </form>
        <div class="preview-port-list" hidden>
          <div class="preview-list-labels"><span>Remote port</span><span>Local port</span></div>
          <div class="preview-connections"></div>
        </div>
      </div>
    </section>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.preview-close').addEventListener('click', goBack);
  overlay.querySelector('.preview-device').addEventListener('click', event => {
    void refreshConnections(event.currentTarget.closest('#previewOverlay'));
  });
  overlay.addEventListener('click', event => {
    if (event.target === overlay) goBack();
    const button = event.target.closest('[data-preview-action]');
    if (!button) return;
    const entry = button.closest('.preview-connection')?.previewConnection || selected;
    if (!entry) return;
    if (button.dataset.previewAction === 'local') void openInline(entry, true);
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
    button.setAttribute('aria-busy', 'true');
    try {
      const origin = await connect(entry);
      if (origin || portNotListening(entry)) {
        input.value = '';
        if (view.isConnected && overlay?.classList.contains('open') && !browserView
          && document.activeElement === button) input.focus();
      } else if (view.isConnected) {
        error.textContent = entry.status;
        error.hidden = false;
      }
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  });
  return overlay;
}

function updateEntry(entry) {
  const connected = !!entry.origin && !entry.tunnel?.closed;
  if (entry.row) {
    const remote = entry.row.querySelector('.preview-remote');
    const unavailable = portNotListening(entry);
    remote.textContent = String(entry.target.port);
    remote.classList.toggle('unavailable', unavailable);
    remote.title = unavailable ? entry.status.replace(/^Preview failed: /, '') : '';
    entry.row.querySelector('.preview-local').textContent = connected
      ? new URL(entry.origin).port || '80' : '—';
    entry.row.querySelector('.preview-local').title = connected ? entry.origin : '';
  }
  if (selected === entry && browserView && !connected && !entry.pending
    && /^(Preview failed:|Forwarding stopped)/.test(entry.status)) browserView.setError(entry.status);
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

async function refreshConnection(entry) {
  const key = JSON.stringify([entry.device, entry.target.port]);
  if (!entry.listed || connections.get(key) !== entry) return null;
  if (entry.pending) {
    await entry.pending;
  } else if (!entry.origin || entry.tunnel?.closed) {
    await connect(entry);
  } else {
    const version = entry.version;
    const tunnel = entry.tunnel;
    try {
      await tunnel.checkPort();
      if (entry.version === version) entry.status = 'Connected.';
    } catch (error) {
      if (entry.version !== version || entry.tunnel !== tunnel) return null;
      const closing = disconnect(entry);
      const stoppedVersion = entry.version;
      await closing;
      if (entry.version === stoppedVersion && entry.listed) {
        const message = error.message || String(error);
        if (portNotListening(entry, message)) {
          entry.status = `Preview failed: ${message}`;
          updateEntry(entry);
          return null;
        }
        return message;
      }
    }
  }
  if (entry.listed && connections.get(key) === entry && (!entry.origin || entry.tunnel?.closed)) {
    return portNotListening(entry) ? null : entry.status;
  }
  return null;
}

async function refreshConnections(view) {
  const device = view.dataset.device;
  const button = view.querySelector('.preview-device');
  const error = view.querySelector('.preview-form-error');
  if (button.disabled) return;
  button.disabled = true;
  error.hidden = true;
  setBreadcrumbItemsLoading([button], true);
  let task = connectionRefreshes.get(device);
  if (!task) {
    const entries = Array.from(connections.values()).filter(entry => entry.listed && entry.device === device);
    task = Promise.all(entries.map(refreshConnection));
    connectionRefreshes.set(device, task);
  }
  try {
    const failures = (await task).filter(Boolean);
    if (overlay === view && view.dataset.device === device) {
      renderList();
      error.textContent = failures.join(' ');
      error.hidden = !failures.length;
    }
  } catch (failure) {
    if (overlay === view && view.dataset.device === device) {
      error.textContent = failure.message || String(failure);
      error.hidden = false;
    }
  } finally {
    if (connectionRefreshes.get(device) === task) connectionRefreshes.delete(device);
    button.disabled = false;
    setBreadcrumbItemsLoading([button], false);
  }
}

function goBack() {
  cancelClose?.();
  navigationVersion++;
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
    if (!browserView) previousFocus?.focus({ preventScroll: true });
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

async function connect(entry, { speculative = false } = {}) {
  if (!speculative) adoptPrewarm(entry);
  if (entry.closing) await entry.closing;
  if (entry.origin && !entry.tunnel?.closed) {
    if (!speculative && !entry.listed) {
      entry.listed = true;
      savePorts();
      renderList();
    }
    return entry.origin;
  }
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
      if (!entry.speculative) entry.listed = true;
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
          if (!entry.listed) {
            if (!entry.speculative && portNotListening(entry)) {
              entry.listed = true;
              savePorts();
              renderList();
            } else {
              connections.delete(JSON.stringify([entry.device, entry.target.port]));
            }
          }
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
  goBack();
  const version = ++navigationVersion;
  selected = entry;
  const requestUrl = entry.target.displayUrl;
  if (cachedBrowser?.entry === entry && cachedBrowser.requestUrl === requestUrl
    && cachedBrowser.page.ready && entry.origin && !entry.tunnel?.closed
    && new URL(cachedBrowser.page.url).origin === entry.origin) {
    cachedBrowser.fromList = fromList;
    if (cachedBrowser.page.resume()) {
      browserView = cachedBrowser.page;
      return;
    }
  }
  cachedBrowser?.page.destroy();
  cachedBrowser = null;
  const page = openBrowserPage({
    keepAlive: true,
    initialAddress: entry.origin && !entry.tunnel?.closed
      ? localUrl(entry.origin, entry.target) : entry.target.displayUrl,
    resolveAddress: async (value, currentUrl) => {
      let target = parsePreviewInput(value);
      if (!target) {
        const url = normalizeBrowserAddress(value, currentUrl);
        target = parsePreviewTarget(url);
        if (!target) {
          if (browserView === page) selected = null;
          return url;
        }
      }
      const origin = new URL(target.displayUrl).origin;
      const existing = Array.from(connections.values()).find(connection =>
        connection.device === entry.device && connection.origin === origin);
      if (existing) target = parsePreviewTarget(`http://127.0.0.1:${existing.target.port}${target.pathname}${target.search}${target.hash}`);
      const connection = getConnection(target, entry.device);
      const localOrigin = await connect(connection);
      if (!localOrigin) throw new Error(connection.status);
      if (browserView === page) selected = connection;
      savePorts();
      return localUrl(localOrigin, target);
    },
    onLocationChange(url) {
      if (browserView !== page) return;
      const origin = new URL(url).origin;
      selected = Array.from(connections.values()).find(connection =>
        connection.device === entry.device && connection.origin === origin) || null;
    },
    onExternal: launchBrowser,
    onStop() {
      if (browserView === page) navigationVersion++;
    },
    onClose() {
      if (browserView !== page) return;
      browserView = null;
      selected = null;
      navigationVersion++;
      if (cachedBrowser?.fromList) showPreviewInput(entry.device);
    },
  });
  cachedBrowser = { page, entry, requestUrl, fromList };
  browserView = page;
  const target = entry.target;
  const origin = await connect(entry);
  if (browserView !== page || selected !== entry || version !== navigationVersion) return;
  if (!origin) {
    page.setError(entry.status);
    return;
  }
  page.setUrl(localUrl(origin, target));
}

async function openBrowser(entry) {
  const target = entry.target;
  const origin = await connect(entry);
  if (!origin) {
    if (overlay?.isConnected) {
      const message = overlay.querySelector('.preview-form-error');
      message.hidden = portNotListening(entry);
      if (!message.hidden) message.textContent = entry.status;
    }
    return;
  }
  try {
    await launchBrowser(localUrl(origin, target));
    if (overlay?.isConnected) overlay.querySelector('.preview-form-error').hidden = true;
  } catch (error) {
    entry.status = `Could not open browser: ${error.message || error}`;
    updateEntry(entry);
    if (overlay?.isConnected) {
      const message = overlay.querySelector('.preview-form-error');
      message.textContent = entry.status;
      message.hidden = false;
    }
  }
}

async function launchBrowser(url) {
  if (/Android/i.test(navigator.userAgent)) {
    await invoke('plugin:in-app-browser|open_chrome', { payload: { url, toolbarColor: '#161b22' } });
  } else {
    await openUrl(url);
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
  if (prewarmedEntry === entry) {
    prewarmedEntry = null;
    prewarmVersion++;
  }
  entry.listed = false;
  connections.delete(JSON.stringify([entry.device, entry.target.port]));
  savePorts();
  const closing = disconnect(entry);
  if (selected === entry && browserView) browserView.close();
  else renderList();
  if (cachedBrowser?.entry === entry) {
    cachedBrowser.page.destroy();
    cachedBrowser = null;
  }
  await closing;
}

export function openPreviewLink(value, device) {
  const target = parsePreviewTarget(value);
  if (!target || !device) return false;
  restorePorts();
  const entry = getConnection(target, device);
  void openInline(entry, false);
  return true;
}

export function showPreviewInput(device) {
  if (!device) return;
  const view = ensureOverlay(device);
  navigationVersion++;
  const opening = !view.classList.contains('bottom-sheet-overlay') || !view.classList.contains('open');
  view.classList.add('modal-overlay', 'bottom-sheet-overlay');
  view.querySelector('.preview-panel').classList.add('modal-box', 'bottom-sheet-panel');
  view.querySelector('.preview-device').textContent = deviceName(device);
  view.querySelector('.preview-device').setAttribute('aria-label', `Refresh port connections for ${deviceName(device)}`);
  renderList();
  if (opening) {
    view.classList.remove('open');
    void view.offsetWidth;
    view.classList.add('open');
  }
  view.querySelector('.preview-close').focus({ preventScroll: true });
}

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !overlay || browserView) return;
  event.preventDefault();
  event.stopPropagation();
  goBack();
}, true);

function closeConnections() {
  connectionRefreshes.clear();
  prewarmVersion++;
  prewarmedEntry = null;
  cachedBrowser?.page.destroy();
  cachedBrowser = null;
  browserView?.destroy();
  browserView = null;
  selected = null;
  goBack();
  for (const entry of connections.values()) void disconnect(entry);
  connections.clear();
  restored = false;
}

window.closePreviewConnections = closeConnections;
window.addEventListener('pagehide', closeConnections);
