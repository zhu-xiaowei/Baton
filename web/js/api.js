// API client — unified util for all pages
// Credentials default to localStorage; can be overridden per-call via opts.{key,server} (used by landing.html before login)

import { state } from './state.js';
import { clearListCaches } from './list-cache.js';
import { clearProjectDataCache } from './cache/project-data-cache.js';
import { showImageViewer } from './components/image-viewer.js';
import { loadingSpinner } from './components/loading.js';
import { cacheAttachment, cachedAttachmentBlob } from './components/attachment-cache.js';
import { imageMimeType } from './components/image-type.js';
import { requestProjectFiles } from './project/rpc.js';
import { currentProjectHash, relativeProjectImagePath } from './project/project-hash.js';

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
var pendingImages = new Map();
var localImageCache = new Map();
var pendingLocalImages = new Map();
var imageContexts = new WeakMap();
var IMAGE_CACHE_MAX = 200;
var IMAGE_URL_CACHE_MS = 50 * 60 * 1000;
var LOCAL_IMAGE_CACHE_MS = 30000;
var imageObserver = new IntersectionObserver(function (entries) {
  entries.forEach(function (entry) {
    if (!entry.isIntersecting) return;
    imageObserver.unobserve(entry.target);
    loadOneImage(entry.target);
  });
}, { rootMargin: '200px' });

function imageStorageKey(key, attachment = false) {
  return JSON.stringify([state.SERVER, state.KEY, attachment, key]);
}

function cachedImageUrl(key) {
  var entry = imageCache.get(key);
  if (entry?.expiresAt > Date.now()) return entry.url;
  forgetImageUrl(key, entry);
  return null;
}

function forgetImageUrl(key, entry) {
  imageCache.delete(key);
  // An object URL still shown on the page stays valid; it is released with the page instead.
  if (entry?.objectUrl && !document.querySelector('img[src="' + CSS.escape(entry.url) + '"]')) {
    URL.revokeObjectURL(entry.url);
  }
}

function rememberImageUrl(key, url, objectUrl, source) {
  if (imageCache.size >= IMAGE_CACHE_MAX) {
    var oldest = imageCache.keys().next().value;
    forgetImageUrl(oldest, imageCache.get(oldest));
  }
  imageCache.set(key, { url, objectUrl, source, expiresAt: objectUrl ? Infinity : Date.now() + IMAGE_URL_CACHE_MS });
  return url;
}

function decodeImage(url) {
  return new Promise(function (resolve, reject) {
    var image = new Image();
    image.onload = resolve;
    image.onerror = function () { reject(new Error('Failed to load image.')); };
    image.src = url;
  });
}

// An image key never changes content, so downloaded images live in IndexedDB and reopening or
// restarting reads them locally. The presigned URL itself is only used when caching fails.
async function getImageUrl(key, attachment = false) {
  var cacheKey = imageStorageKey(key, attachment);
  var cached = cachedImageUrl(cacheKey);
  if (cached) return cached;
  if (pendingImages.has(cacheKey)) return pendingImages.get(cacheKey);
  var storeKey = (attachment ? '' : 'images/') + key;
  var source = { key, attachment };
  var promise = (async function () {
    var blob = await cachedAttachmentBlob(storeKey);
    var file = null;
    if (!blob) {
      file = await api('/api/bridge/image-url/' + encodeURIComponent(key),
        attachment ? { attachment: 'true' } : undefined);
      blob = await fetch(file.url).then(function (response) { return response.ok ? response.blob() : null; })
        .catch(function () { return null; });
      if (!blob) {
        await decodeImage(file.url);
        return rememberImageUrl(cacheKey, file.url, false, source);
      }
    }
    // Stored Blobs may lack a type, which SVG needs to render.
    var url = URL.createObjectURL(blob.slice(0, blob.size, imageMimeType(key) || blob.type));
    try {
      await decodeImage(url);
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
    if (file) cacheAttachment(storeKey, key, blob);
    return rememberImageUrl(cacheKey, url, true, source);
  })().finally(function () { pendingImages.delete(cacheKey); });
  pendingImages.set(cacheKey, promise);
  return promise;
}

function currentImageContext(override = {}) {
  return {
    device: override.device ?? state.appState.device ?? '',
    projectHash: override.projectHash || currentProjectHash(),
  };
}

function automaticImagePath(path, context) {
  var relative = relativeProjectImagePath(path, context.projectHash);
  if (relative !== null) return relative;
  if (context.device !== state.appState.device || context.projectHash !== currentProjectHash()) return null;
  var blocks = (state.wsAllMessages || []).flatMap(message =>
    Array.isArray(message.content) ? message.content : []);
  var completed = new Set(blocks.filter(block =>
    block?.type === 'tool_result' && block.tool_use_id && !block.is_error).map(block => block.tool_use_id));
  var normalize = value => String(value || '').replaceAll('\\', '/');
  var viewed = blocks.some(block => block?.type === 'tool_use' && block.name === 'ViewImage'
    && block.id && completed.has(block.id) && normalize(block.input?.path || block.input?.file_path) === normalize(path));
  return viewed ? path : null;
}

function localImageKey(path, context) {
  return JSON.stringify([state.SERVER, state.KEY, context.device, context.projectHash, path]);
}

function cachedLocalImage(path, context) {
  var key = localImageKey(path, context);
  var entry = localImageCache.get(key);
  if (entry?.expiresAt > Date.now()) return entry.url;
  localImageCache.delete(key);
  return null;
}

async function getLocalImageUrl(path, context) {
  if (!context.device || !context.projectHash) throw new Error('Open the original project to load this image.');
  var cacheKey = localImageKey(path, context);
  var cached = cachedLocalImage(path, context);
  if (cached) return cached;
  if (pendingLocalImages.has(cacheKey)) return pendingLocalImages.get(cacheKey);
  var promise = requestProjectFiles('read', { ...context, path }).then(async function (response) {
    if (!response.image || !response.key) throw new Error('The file is not an image.');
    var url = await getImageUrl(response.key, response.attachment);
    if (localImageCache.size >= IMAGE_CACHE_MAX) localImageCache.delete(localImageCache.keys().next().value);
    localImageCache.set(cacheKey, { url, expiresAt: Date.now() + LOCAL_IMAGE_CACHE_MS });
    return url;
  }).finally(function () { pendingLocalImages.delete(cacheKey); });
  pendingLocalImages.set(cacheKey, promise);
  return promise;
}

function showLoadedImage(el, url) {
  var image = document.createElement('img');
  image.src = url;
  image.alt = el.dataset.alt || '';
  image.onclick = function (event) {
    event.preventDefault();
    event.stopPropagation();
    viewImage(image.src, image);
  };
  el.classList.add('loaded');
  delete el.dataset.failed;
  el.replaceChildren(image);
}

function imageLoadAction(el, label, detail, manual) {
  var button = document.createElement('button');
  button.type = 'button';
  button.className = 'image-load-action';
  button.textContent = label;
  button.title = detail || label;
  button.setAttribute('aria-label', label === 'Retry' ? 'Retry image' : label);
  button.onclick = function (event) {
    event.preventDefault();
    event.stopPropagation();
    delete el.dataset.failed;
    el.innerHTML = loadingSpinner({ label: 'Loading image' });
    loadOneImage(el, manual);
  };
  el.classList.remove('loaded');
  el.replaceChildren(button);
}

async function loadOneImage(el, manual = false) {
  var context = imageContexts.get(el) || currentImageContext();
  var path = el.dataset.path;
  var requestPath = path && (manual ? path : automaticImagePath(path, context));
  if (path && requestPath === null) {
    imageLoadAction(el, 'Load image', 'Load image from this device', true);
    return;
  }
  try {
    var url = path ? await getLocalImageUrl(requestPath, context)
      : await getImageUrl(el.dataset.key);
    showLoadedImage(el, url);
  } catch(e) {
    el.dataset.failed = '1';
    imageLoadAction(el, 'Retry', e.message || 'Image unavailable', manual);
  }
}

function loadImages(container, contextOverride) {
  container.querySelectorAll('.img-placeholder[data-key], .img-placeholder[data-path]').forEach(function (el) {
    if (el.dataset.loaded) return;
    el.dataset.loaded = '1';
    var cached;
    if (el.dataset.path) {
      var context = currentImageContext(contextOverride);
      imageContexts.set(el, context);
      var path = automaticImagePath(el.dataset.path, context);
      if (path === null) {
        imageLoadAction(el, 'Load image', 'Load image from this device', true);
        return;
      }
      cached = cachedLocalImage(path, context);
    } else {
      cached = cachedImageUrl(imageStorageKey(el.dataset.key));
    }
    if (cached) { showLoadedImage(el, cached); return; }
    imageObserver.observe(el);
  });
}

// Images sent together in one message open as one gallery, like the staged images before sending.
// The key comes from data-key (a just-sent image still shows its local copy) or its placeholder.
function viewImage(src, element) {
  var group = element?.closest('.msg-attachments');
  var images = group ? Array.from(group.querySelectorAll('.img-placeholder.loaded img')) : [];
  if (!images.includes(element)) images = [element || { src }];
  var entries = Array.from(imageCache.values());
  showImageViewer(images.map(image => {
    var key = image.dataset?.key || image.closest?.('.img-placeholder[data-key]')?.dataset.key;
    return { src: image.src, ...(key ? { key } : entries.find(entry => entry.url === image.src)?.source) };
  }),
  Math.max(0, images.indexOf(element)));
}

// Function bridges for inline HTML handlers + legacy IIFE consumers.
// State (KEY/SERVER/WS_URL) lives in state.js, not on window.
Object.assign(window, {
  setCredentials, clearCredentials, logout,
  api, apiText, apiPost, loadingSpinner,
  loadOneImage, loadImages, viewImage, getImageUrl,
});
