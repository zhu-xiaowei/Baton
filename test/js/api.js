// API client + config management
var SERVER = '';
var KEY = '';
var WS_URL = '';

function setStatus(msg, type) {
  var el = document.getElementById('configStatus');
  el.textContent = msg;
  el.className = 'status ' + (type || '');
}

function collapseConfig() {
  document.getElementById('configExpanded').style.display = 'none';
  document.getElementById('configHostHint').textContent = SERVER.replace(/https?:\/\//, '').split('/')[0];
  document.getElementById('configCollapsed').style.display = 'block';
}

function toggleConfig() {
  var expanded = document.getElementById('configExpanded');
  var collapsed = document.getElementById('configCollapsed');
  if (expanded.style.display === 'none') {
    expanded.style.display = 'block';
    collapsed.style.display = 'none';
  } else {
    collapseConfig();
  }
}

async function api(path, params) {
  var qs = new URLSearchParams(params || {}).toString();
  var url = SERVER + path + (qs ? '?' + qs : '');
  var res = await fetch(url, { headers: { 'x-api-key': KEY } });
  if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
  return res.json();
}

async function connect() {
  SERVER = document.getElementById('serverUrl').value.replace(/\/$/, '');
  KEY = document.getElementById('apiKey').value;
  if (!SERVER || !KEY) { setStatus('Please fill in both fields', 'err'); return; }

  localStorage.setItem('agentpeek-config', JSON.stringify({ server: SERVER, key: KEY }));
  setStatus('Connecting...');
  try {
    await api('/api/health');
    try {
      var cfg = await api('/api/bridge/config');
      WS_URL = cfg.wsUrl || '';
    } catch {}
    setStatus('Connected', 'ok');
    collapseConfig();
    loadDevices();
  } catch (e) {
    setStatus('Failed: ' + e.message, 'err');
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

// Load saved config
(function () {
  var saved = localStorage.getItem('agentpeek-config');
  if (saved) {
    var c = JSON.parse(saved);
    document.getElementById('serverUrl').value = c.server || '';
    document.getElementById('apiKey').value = c.key || '';
  }
})();
