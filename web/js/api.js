// API client — unified util for all pages
// Credentials default to localStorage; can be overridden per-call via opts.{key,server} (used by landing.html before login)

import { state } from './state.js';

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

function setCredentials(key, server) {
  state.KEY = key;
  if (server) state.SERVER = server.replace(/\/+$/, '');
  localStorage.setItem('_ak', btoa(key));
  if (server) localStorage.setItem('_as', state.SERVER);
}

function clearCredentials() {
  state.KEY = '';
  state.WS_URL = '';
  localStorage.removeItem('_ak');
  localStorage.removeItem('_as');
  localStorage.removeItem('_wsurl');
  localStorage.removeItem('agentpeek-nav');
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
  return (await _do(path, params, opts)).json();
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
var IMAGE_CACHE_MAX = 200;
var imageObserver = new IntersectionObserver(function (entries) {
  entries.forEach(function (entry) {
    if (!entry.isIntersecting) return;
    imageObserver.unobserve(entry.target);
    loadOneImage(entry.target);
  });
}, { rootMargin: '200px' });

async function loadOneImage(el) {
  var key = el.dataset.key;
  if (imageCache.has(key)) {
    el.classList.add('loaded');
    el.innerHTML = '<img src="' + imageCache.get(key) + '" onclick="viewImage(this.src)" />';
    return;
  }
  try {
    var b64 = await apiText('/api/bridge/image/' + key);
    var dataUrl = 'data:image/jpeg;base64,' + b64;
    if (imageCache.size >= IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
    imageCache.set(key, dataUrl);
    el.classList.add('loaded');
    el.innerHTML = '<img src="' + dataUrl + '" onclick="viewImage(this.src)" />';
  } catch(e) { el.textContent = '[Image error]'; }
}

function loadImages(container) {
  container.querySelectorAll('.img-placeholder[data-key]').forEach(function (el) {
    if (el.dataset.loaded) return;
    el.dataset.loaded = '1';
    imageObserver.observe(el);
  });
}

function viewImage(src) {
  var overlay = document.getElementById('imgOverlay');
  document.getElementById('imgOverlayImg').src = src;
  overlay.style.display = 'flex';
}

// Function bridges for inline HTML handlers + legacy IIFE consumers.
// State (KEY/SERVER/WS_URL) lives in state.js, not on window.
Object.assign(window, {
  setCredentials, clearCredentials, logout,
  api, apiText, apiPost,
  loadOneImage, loadImages, viewImage,
});
