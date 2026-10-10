import { registerEdgeBackLayer } from '../edge-back.js';
import frameBridge from './frame-bridge.js?raw';
import '../../css/breadcrumb.css';
import '../../css/workspace-header.css';
import './browser.css';

let activePage = null;
const icons = {
  back: '<path d="m15 18-6-6 6-6"/>',
  forward: '<path d="m9 18 6-6-6-6"/>',
  reload: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  external: '<path d="M15 3h6v6m0-6L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
};

function button(action, label) {
  return `<button class="workspace-switch browser-button" type="button" data-browser-action="${action}"
    aria-label="${label}" title="${label}"><svg viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true">${icons[action]}</svg></button>`;
}

function httpUrl(value, base) {
  const url = new URL(value, base || undefined);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Enter an HTTP or HTTPS address.');
  }
  return url.href;
}

export function openBrowserPage(options = {}) {
  activePage?.destroy();
  const previousFocus = document.activeElement;
  const root = document.createElement('section');
  root.id = 'internalBrowserPage';
  root.className = 'browser-page is-loading';
  root.setAttribute('aria-label', 'Web preview');
  root.setAttribute('aria-busy', 'true');
  root.innerHTML = `
    <header class="path-breadcrumb browser-toolbar">
      <div class="browser-navigation">
        ${button('back', 'Back')}
        ${button('forward', 'Forward')}
        ${button('reload', 'Reload')}
      </div>
      <form class="browser-address-form">
        <input class="browser-address" aria-label="Address" placeholder="Enter address"
          type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false">
      </form>
      <div class="browser-window-actions">
        ${button('external', 'Open in browser')}
        ${button('close', 'Close preview')}
      </div>
    </header>
    <main class="browser-content">
      <p class="browser-message" role="alert" hidden></p>
      <iframe class="browser-frame" title="Preview page"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
        allow="clipboard-read; clipboard-write" hidden></iframe>
    </main>`;
  document.body.appendChild(root);
  const frame = root.querySelector('.browser-frame');
  const address = root.querySelector('.browser-address');
  const message = root.querySelector('.browser-message');
  const token = crypto.randomUUID();
  const urls = [];
  let position = -1;
  let currentUrl = '';
  let pendingDelta = 0;
  let awaitingLoad = false;
  let bridgeReady = false;
  let destroyed = false;
  let navigationVersion = 0;
  let loadingTimer = null;
  const edgeBack = registerEdgeBackLayer({
    navigateBack: () => position > 0 ? traverse(-1) : close(),
    foregroundSelectors: ['#internalBrowserPage'],
    underlaySelectors: ['body > .top-bar', '#breadcrumb', '#content'],
    guardZIndex: 1401,
  });
  edgeBack.activate();

  function updateControls() {
    root.querySelector('[data-browser-action="back"]').disabled = position <= 0 || !!pendingDelta;
    root.querySelector('[data-browser-action="forward"]').disabled = position >= urls.length - 1 || !!pendingDelta;
    root.querySelector('[data-browser-action="reload"]').disabled = !currentUrl;
    root.querySelector('[data-browser-action="external"]').disabled = !currentUrl;
    if (document.activeElement !== address) address.value = currentUrl;
  }

  function setLoading(loading) {
    clearTimeout(loadingTimer);
    root.classList.toggle('is-loading', loading);
    root.setAttribute('aria-busy', String(loading));
    if (loading) loadingTimer = setTimeout(() => setError('The page is taking too long to load. Try reloading.'), 30000);
  }

  function setError(error) {
    if (destroyed) return;
    setLoading(false);
    message.textContent = error;
    message.hidden = false;
  }

  function post(action) {
    frame.contentWindow?.postMessage({ type: 'baton-browser-command', token, action }, '*');
  }

  function setUrl(value, historyPosition) {
    if (destroyed) return;
    const url = httpUrl(value, currentUrl);
    if (historyPosition !== undefined) position = historyPosition;
    else {
      urls.splice(position + 1);
      urls.push(url);
      position = urls.length - 1;
    }
    urls[position] = url;
    currentUrl = url;
    address.value = url;
    awaitingLoad = true;
    bridgeReady = false;
    message.hidden = true;
    frame.hidden = false;
    setLoading(true);
    frame.src = url;
    updateControls();
  }

  async function navigate(value) {
    const version = ++navigationVersion;
    try {
      setLoading(true);
      message.hidden = true;
      const resolved = options.resolveAddress
        ? await options.resolveAddress(value, currentUrl)
        : httpUrl(value, currentUrl);
      if (!destroyed && version === navigationVersion) setUrl(resolved);
    } catch (error) {
      if (version === navigationVersion) setError(error.message || String(error));
    }
  }

  function traverse(delta) {
    const next = position + delta;
    if (next < 0 || next >= urls.length) return;
    if (bridgeReady) {
      pendingDelta = delta;
      updateControls();
      setLoading(true);
      post(delta < 0 ? 'back' : 'forward');
    } else {
      setUrl(urls[next], next);
    }
  }

  function receive(event) {
    const data = event.data;
    if (event.source !== frame.contentWindow || data?.type !== 'baton-browser-state' || data.token !== token) return;
    let url;
    try { url = httpUrl(data.url); } catch { return; }
    if (event.origin !== new URL(url).origin) return;
    bridgeReady = true;
    if (pendingDelta) {
      position += pendingDelta;
      urls[position] = url;
      pendingDelta = 0;
    } else if (awaitingLoad || data.mode === 'replace') {
      if (position >= 0) urls[position] = url;
    } else if (data.mode === 'pop') {
      const previous = urls.lastIndexOf(url, position - 1);
      const next = urls.indexOf(url, position + 1);
      if (previous >= 0) position = previous;
      else if (next >= 0) position = next;
    } else if (url !== currentUrl || data.mode === 'push') {
      urls.splice(position + 1);
      urls.push(url);
      position = urls.length - 1;
    }
    awaitingLoad = false;
    currentUrl = url;
    options.onLocationChange?.(url);
    setLoading(false);
    updateControls();
  }

  frame.addEventListener('load', () => {
    if (!currentUrl || destroyed) return;
    bridgeReady = false;
    try { frame.contentWindow.eval(frameBridge); } catch {}
    frame.contentWindow?.postMessage({ type: 'baton-browser-init', token }, '*');
    setLoading(false);
  });
  window.addEventListener('message', receive);
  root.querySelector('.browser-address-form').addEventListener('submit', event => {
    event.preventDefault();
    const value = address.value.trim();
    address.blur();
    void navigate(value);
  });
  root.addEventListener('click', event => {
    const action = event.target.closest('[data-browser-action]')?.dataset.browserAction;
    if (action === 'back') traverse(-1);
    if (action === 'forward') traverse(1);
    if (action === 'reload' && currentUrl) {
      message.hidden = true;
      setLoading(true);
      if (bridgeReady) post('reload');
      else setUrl(currentUrl, position);
    }
    if (action === 'external' && currentUrl) {
      Promise.resolve(options.onExternal?.(currentUrl)).catch(error => setError(error.message || String(error)));
    }
    if (action === 'close') close();
  });
  function onEscape(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (document.activeElement === address) {
      address.value = currentUrl;
      address.blur();
    } else close();
  }
  document.addEventListener('keydown', onEscape, true);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    navigationVersion++;
    clearTimeout(loadingTimer);
    window.removeEventListener('message', receive);
    document.removeEventListener('keydown', onEscape, true);
    edgeBack.unregister();
    root.remove();
    if (activePage === controller) activePage = null;
  }

  function close() {
    destroy();
    previousFocus?.focus({ preventScroll: true });
    options.onClose?.();
  }

  const controller = { setUrl, setError, close, destroy, get url() { return currentUrl; } };
  activePage = controller;
  updateControls();
  if (options.url) setUrl(options.url);
  return controller;
}
