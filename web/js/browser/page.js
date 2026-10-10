import { registerEdgeBackLayer } from '../edge-back.js';
import { normalizeBrowserAddress } from './address.js';
import frameBridge from './frame-bridge.js?raw';
import '../../css/breadcrumb.css';
import '../../css/workspace-header.css';
import './browser.css';

let activePage = null;
const icons = {
  back: '<path d="m15 18-6-6 6-6"/>',
  forward: '<path d="m9 18 6-6-6-6"/>',
  reload: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  stop: '<path d="m6 6 12 12M18 6 6 18"/>',
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
  let previousFocus = document.activeElement;
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
      </div>
      <form class="browser-address-form">
        <input class="browser-address" aria-label="Address" placeholder="Enter address"
          type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false">
        ${button('reload', 'Reload')}
        <span class="browser-load-progress" aria-hidden="true"></span>
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
  const initialAddress = options.initialAddress || options.url || '';
  address.value = initialAddress;
  const message = root.querySelector('.browser-message');
  const progress = root.querySelector('.browser-load-progress');
  const loadAction = root.querySelector('.browser-address-form .browser-button');
  let token = crypto.randomUUID();
  let documentId = null;
  const urls = [];
  let position = -1;
  let currentUrl = '';
  let pendingDelta = 0;
  let awaitingLoad = false;
  let bridgeReady = false;
  let destroyed = false;
  let suspended = false;
  let navigationVersion = 0;
  let loadingTimer = null;
  let completionTimer = null;
  let loading = false;
  let loadStopped = false;
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
    loadAction.disabled = !loading && !currentUrl && !initialAddress;
    root.querySelector('[data-browser-action="external"]').disabled = !currentUrl;
    if (document.activeElement !== address) address.value = currentUrl || initialAddress;
  }

  function setLoading(active, completed = true, restart = false) {
    if (active && loadStopped) return;
    if (active === loading && !restart) return;
    loading = active;
    const action = active ? 'stop' : 'reload';
    const label = active ? 'Stop loading' : 'Reload';
    loadAction.dataset.browserAction = action;
    loadAction.setAttribute('aria-label', label);
    loadAction.title = label;
    loadAction.querySelector('svg').innerHTML = icons[action];
    loadAction.disabled = !active && !currentUrl && !initialAddress;
    clearTimeout(loadingTimer);
    clearTimeout(completionTimer);
    root.setAttribute('aria-busy', String(active));
    if (active) {
      progress.style.transition = 'none';
      progress.style.transform = 'scaleX(0)';
      root.classList.add('is-loading');
      void progress.offsetWidth;
      progress.style.transition = 'transform 8s cubic-bezier(.1,.65,.15,1), opacity 150ms ease-out';
      progress.style.transform = 'scaleX(0.9)';
      loadingTimer = setTimeout(() => setError('The page is taking too long to load. Try reloading.'), 30000);
    } else if (completed) {
      progress.style.transition = 'transform 160ms ease-out, opacity 150ms ease-out';
      progress.style.transform = 'scaleX(1)';
      completionTimer = setTimeout(() => root.classList.remove('is-loading'), 180);
    } else {
      root.classList.remove('is-loading');
    }
  }

  function setError(error) {
    if (destroyed) return;
    setLoading(false, false);
    message.textContent = error;
    message.hidden = false;
  }

  function post(action) {
    frame.contentWindow?.postMessage({ type: 'baton-browser-command', token, action }, '*');
  }

  function stopLoading() {
    navigationVersion++;
    loadStopped = true;
    pendingDelta = 0;
    setLoading(false, false);
    if (bridgeReady || documentId) {
      post('stop');
    } else {
      try { frame.contentWindow?.stop(); }
      catch { frame.src = 'about:blank'; }
    }
    options.onStop?.();
    updateControls();
  }

  function setUrl(value, historyPosition) {
    if (destroyed) return;
    const url = normalizeBrowserAddress(value, currentUrl);
    const previous = currentUrl && new URL(currentUrl);
    const next = new URL(url);
    const hashNavigation = previous && previous.origin === next.origin
      && previous.pathname === next.pathname && previous.search === next.search
      && previous.hash !== next.hash;
    if (historyPosition !== undefined) position = historyPosition;
    else {
      urls.splice(position + 1);
      urls.push(url);
      position = urls.length - 1;
    }
    urls[position] = url;
    currentUrl = url;
    loadStopped = false;
    if (!hashNavigation) {
      token = crypto.randomUUID();
      documentId = null;
    }
    address.value = url;
    awaitingLoad = true;
    bridgeReady = false;
    message.hidden = true;
    frame.hidden = false;
    setLoading(true, true, true);
    frame.src = url;
    updateControls();
  }

  async function navigate(value) {
    const version = ++navigationVersion;
    try {
      loadStopped = false;
      setLoading(true);
      message.hidden = true;
      const resolved = options.resolveAddress
        ? await options.resolveAddress(value, currentUrl)
        : normalizeBrowserAddress(value, currentUrl);
      if (!destroyed && version === navigationVersion) setUrl(resolved);
    } catch (error) {
      if (version === navigationVersion) setError(error.message || String(error));
    }
  }

  function traverse(delta) {
    const next = position + delta;
    if (next < 0 || next >= urls.length) return;
    loadStopped = false;
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
    if (event.source !== frame.contentWindow || !data) return;
    let url;
    try { url = httpUrl(data.url); } catch { return; }
    if (event.origin !== new URL(url).origin) return;
    if (data.type === 'baton-browser-available') {
      if (documentId !== data.documentId) {
        const redirected = documentId !== null;
        documentId = data.documentId;
        token = crypto.randomUUID();
        setLoading(true, true, redirected);
      }
      frame.contentWindow?.postMessage({ type: 'baton-browser-init', token, documentId }, '*');
      if (loadStopped) post('stop');
      return;
    }
    if (data.type !== 'baton-browser-state' || data.token !== token
      || (documentId && data.documentId !== documentId)) return;
    if (data.mode === 'navigating') {
      loadStopped = false;
      setLoading(true);
      return;
    }
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
    if (data.mode === 'stopped') loadStopped = true;
    if (loadStopped) setLoading(false, false);
    else if (data.mode === 'loading' || data.readyState === 'loading') setLoading(true);
    else setLoading(false);
    updateControls();
  }

  frame.addEventListener('load', () => {
    if (!currentUrl || destroyed) return;
    let installed = false;
    try {
      frame.contentWindow.eval(frameBridge);
      installed = !!frame.contentWindow.__batonBrowserFrame;
    } catch {}
    frame.contentWindow?.postMessage({ type: 'baton-browser-init', token, documentId }, '*');
    if (!documentId && !installed) setLoading(false);
  });
  window.addEventListener('message', receive);
  root.addEventListener('selectstart', event => {
    if (!event.target.closest?.('.browser-address')) event.preventDefault();
  });
  root.addEventListener('contextmenu', event => {
    if (event.target.closest?.('.browser-toolbar') && !event.target.closest('.browser-address')) {
      event.preventDefault();
    }
  });
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
    if (action === 'stop') stopLoading();
    if (action === 'reload' && !currentUrl && initialAddress) void navigate(initialAddress);
    if (action === 'reload' && currentUrl) {
      loadStopped = false;
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
    clearTimeout(completionTimer);
    window.removeEventListener('message', receive);
    document.removeEventListener('keydown', onEscape, true);
    edgeBack.unregister();
    root.remove();
    if (activePage === controller) activePage = null;
  }

  function close() {
    if (options.keepAlive) {
      suspended = true;
      root.hidden = true;
      root.inert = true;
      edgeBack.deactivate();
      document.removeEventListener('keydown', onEscape, true);
    } else destroy();
    previousFocus?.focus({ preventScroll: true });
    options.onClose?.();
  }

  function resume() {
    if (destroyed || !suspended) return false;
    if (activePage && activePage !== controller) activePage.destroy();
    activePage = controller;
    previousFocus = document.activeElement;
    suspended = false;
    root.hidden = false;
    root.inert = false;
    edgeBack.activate();
    document.addEventListener('keydown', onEscape, true);
    return true;
  }

  const controller = {
    setUrl, setError, close, destroy, resume,
    get url() { return currentUrl; },
    get ready() { return !destroyed && !loading && message.hidden; },
  };
  activePage = controller;
  setLoading(true);
  updateControls();
  if (options.url) setUrl(options.url);
  return controller;
}
