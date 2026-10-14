// API client — unified util for all pages
// Credentials default to localStorage; can be overridden per-call via opts.{key,server} (used by landing.html before login)

import { state } from './state.js';
import { clearListCaches } from './list-cache.js';
import { clearProjectDataCache } from './cache/project-data-cache.js';
import { showImageViewer } from './components/image-viewer.js';
import { loadingSpinner } from './components/loading.js';
import { requestProjectFiles } from './project/rpc.js';

state.SERVER = (localStorage.getItem('_as') || (location.origin + location.pathname.replace(/\/[^/]*$/, ''))).replace(/\/$/, '');
state.KEY = (function () {
  try {
    var v = localStorage.getItem('_ak');
    if (!v) return '';
    var decoded = atob(v);
    if (!/^[A-Za-z0-9_\-]+$/.test(decoded)) {
      localStorage.removeItem('_ak');
      return '';
    }
    return decoded;
  } catch(e) {
    localStorage.removeItem('_ak');
    return '';
  }
})();
state.WS_URL = localStorage.getItem('_wsurl') || '';

function clearCachedAccountData() {
  window.closeProjectTerminal?.({ keepAlive: false });
  window.closePreviewConnections?.();
  window.disconnectWs?.();
  state.WS_URL = '';
  localStorage.removeItem('_wsurl');
  localStorage.removeItem('apeek_home_cache');
  localStorage.removeItem('baton-preview-ports');
  localStorage.removeItem('baton-nav'); // legacy location
  sessionStorage.removeItem('baton-nav');
  clearListCaches();
  clearProjectDataCache();
}

function setCredentials(key, server) {
  var prev = ''; try { prev = atob(localStorage.getItem('_ak') || ''); } catch (e) {}
  var nextServer = server ? server.replace(/\/+$/, '') : state.SERVER;
  if (prev !== key || state.SERVER !== nextServer) clearCachedAccountData();
  state.KEY = key;
  state.SERVER = nextServer;
  localStorage.setItem('_ak', btoa(key));
  if (server) localStorage.setItem('_as', state.SERVER);
}

function clearCredentials() {
  state.KEY = '';
  localStorage.removeItem('_ak');
  localStorage.removeItem('_as');
  clearCachedAccountData();
}

function logout() {
  clearCredentials();
  location.replace('landing.html');
}

function _build(path, params, opts) {
  var qs = new URLSearchParams(params || {}).toString();
  return ((opts && opts.server) || state.SERVER) + path + (qs ? '?' + qs : '');
}

function _hdr(opts) {
  var h = { 'x-api-key': (opts && opts.key) || state.KEY };
  if (opts && opts.contentType) h['Content-Type'] = opts.contentType;
  return h;
}

async function _do(path, params, opts, init) {
  var res = await fetch(_build(path, params, opts), Object.assign({ headers: _hdr(opts) }, init || {}));
  // Skip auto-logout when caller passed explicit key (landing.html validates user input).
  if ((res.status === 401 || res.status === 403) && !(opts && opts.key)) logout();
  if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
  return res;
}

async function api(path, params, opts) {
  return (await _do(path, params, opts, opts && opts.signal ? { signal: opts.signal } : null)).json();
}

async function apiText(path, params, opts) {
  return (await _do(path, params, opts)).text();
}

async function apiPost(path, body, opts) {
  var hdr = _hdr(Object.assign({}, opts, { contentType: 'application/json' }));
  var res = await fetch(_build(path, null, opts), { method: 'POST', headers: hdr, body: JSON.stringify(body || {}) });
  if ((res.status === 401 || res.status === 403) && !(opts && opts.key)) logout();
  if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
  return res.json();
}

// ---- Image loading ----
var imageCache = new Map();
var localImageCache = new Map();
var pendingLocalImages = new Map();
var imageContexts = new WeakMap();
var IMAGE_CACHE_MAX = 200;
var imageObserver = new IntersectionObserver(function (entries) {
  entries.forEach(function (entry) {
    if (!entry.isIntersecting) return;
    imageObserver.unobserve(entry.target);
    loadOneImage(entry.target);
  });
}, { rootMargin: '200px' });

// Fetch an image as a data URL, reusing the shared in-memory imageCache.
// mime lets non-JPEG previews (svg/png/etc.) build a correct data: prefix.
async function getImageDataUrl(key, mime) {
  if (imageCache.has(key)) return imageCache.get(key);
  var b64 = await apiText('/api/bridge/image/' + key);
  var dataUrl = 'data:' + (mime || 'image/jpeg') + ';base64,' + b64;
  if (imageCache.size >= IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
  imageCache.set(key, dataUrl);
  return dataUrl;
}

function currentImageContext(el) {
  var project = state.appState.project;
  var owner = el?.closest('[data-block-id], [data-native-id], [data-message-id]');
  return {
    device: state.appState.device || '',
    projectHash: (typeof project === 'string' ? project : project?.hash) || state.wsProjectHash || '',
    scope: [
      state.activeThreadId || state.wsSessionId || state.appState.session || '',
      el?.closest('[data-turn-id]')?.dataset.turnId || '',
      owner?.dataset.blockId || owner?.dataset.nativeId || owner?.dataset.messageId || '',
    ],
  };
}

async function getLocalImageDataUrl(path, context) {
  if (!context.device || !context.projectHash) throw new Error('Open the original project to load this image.');
  var cacheKey = JSON.stringify([state.SERVER, state.KEY, context.device, context.projectHash, context.scope, path]);
  if (localImageCache.has(cacheKey)) return localImageCache.get(cacheKey);
  if (pendingLocalImages.has(cacheKey)) return pendingLocalImages.get(cacheKey);
  var promise = requestProjectFiles('read', { ...context, path }).then(async function (response) {
    if (!response.image || !response.key) throw new Error('The file is not an image.');
    var ext = response.key.split('.').pop().toLowerCase();
    var mime = ext === 'svg' ? 'image/svg+xml' : ext === 'ico' ? 'image/x-icon'
      : 'image/' + (ext === 'jpg' ? 'jpeg' : ext);
    var dataUrl = await getImageDataUrl(response.key, mime);
    if (localImageCache.size >= IMAGE_CACHE_MAX) localImageCache.delete(localImageCache.keys().next().value);
    localImageCache.set(cacheKey, dataUrl);
    return dataUrl;
  }).finally(function () { pendingLocalImages.delete(cacheKey); });
  pendingLocalImages.set(cacheKey, promise);
  return promise;
}

async function loadOneImage(el) {
  var key = el.dataset.key;
  try {
    var dataUrl = el.dataset.path
      ? await getLocalImageDataUrl(el.dataset.path, imageContexts.get(el) || currentImageContext(el))
      : await getImageDataUrl(key);
    var image = document.createElement('img');
    image.src = dataUrl;
    image.alt = el.dataset.alt || '';
    image.setAttribute('onclick', 'event.preventDefault();event.stopPropagation();viewImage(this.src)');
    el.classList.add('loaded');
    el.replaceChildren(image);
  } catch(e) {
    el.textContent = '[Image unavailable · Retry]';
    el.title = e.message || 'Image unavailable';
    el.dataset.failed = '1';
    el.onclick = function () {
      delete el.dataset.failed;
      el.onclick = null;
      el.removeAttribute('title');
      el.innerHTML = loadingSpinner({ label: 'Loading image' });
      loadOneImage(el);
    };
  }
}

function loadImages(container) {
  container.querySelectorAll('.img-placeholder[data-key], .img-placeholder[data-path]').forEach(function (el) {
    if (el.dataset.loaded) return;
    el.dataset.loaded = '1';
    if (el.dataset.path) imageContexts.set(el, currentImageContext(el));
    imageObserver.observe(el);
  });
}

function viewImage(src) {
  showImageViewer(src);
}

// Function bridges for inline HTML handlers + legacy IIFE consumers.
// State (KEY/SERVER/WS_URL) lives in state.js, not on window.
Object.assign(window, {
  setCredentials, clearCredentials, logout,
  api, apiText, apiPost, loadingSpinner,
  loadOneImage, loadImages, viewImage, getImageDataUrl,
});
