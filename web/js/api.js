// API client — reads credentials from localStorage (set by landing.html)
var pathPrefix = location.pathname.replace(/\/[^/]*$/, '');
var SERVER = (localStorage.getItem('_as') || (location.origin + pathPrefix)).replace(/\/$/, '');
var KEY = (function () { try { var v = localStorage.getItem('_ak'); return v ? atob(v) : ''; } catch { return ''; } })();
var WS_URL = '';

function logout() {
  localStorage.removeItem('_ak');
  localStorage.removeItem('_as');
  localStorage.removeItem('agentpeek-nav');
  location.replace('landing.html');
}

async function api(path, params) {
  var qs = new URLSearchParams(params || {}).toString();
  var url = SERVER + path + (qs ? '?' + qs : '');
  var res = await fetch(url, { headers: { 'x-api-key': KEY } });
  if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
  return res.json();
}

async function initConnection() {
  try {
    await api('/api/health');
    try {
      var cfg = await api('/api/bridge/config');
      WS_URL = cfg.wsUrl || '';
    } catch {}
    return true;
  } catch {
    return false;
  }
}

// Image loading
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
    var res = await fetch(SERVER + '/api/bridge/image/' + key, { headers: { 'x-api-key': KEY } });
    if (!res.ok) { el.textContent = '[Image ' + res.status + ']'; return; }
    var b64 = await res.text();
    var dataUrl = 'data:image/jpeg;base64,' + b64;
    if (imageCache.size >= IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
    imageCache.set(key, dataUrl);
    el.classList.add('loaded');
    el.innerHTML = '<img src="' + dataUrl + '" onclick="viewImage(this.src)" />';
  } catch { el.textContent = '[Image error]'; }
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
