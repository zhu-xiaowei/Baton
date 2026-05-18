// Entry for landing.html — login + server/key entry
import { state } from './state.js';
import './api.js';

(function () {
  // Determine if running inside Tauri/native (non-http origin)
  var isNativeApp = !location.origin.startsWith('http') || location.origin.includes('tauri.localhost');
  var defaultServer = isNativeApp
    ? (localStorage.getItem('_as') || '')
    : (location.origin + location.pathname.replace(/\/[^/]*$/, ''));

  if (isNativeApp) {
    document.getElementById('serverGroup').style.display = 'block';
    if (defaultServer) document.getElementById('serverInput').value = defaultServer;
    setupScan();
  } else {
    var scanBtn = document.getElementById('scanBtn');
    if (scanBtn) scanBtn.style.display = 'none';
  }

  // Check URL ?key= param
  var urlKey = new URLSearchParams(location.search).get('key');
  if (urlKey) {
    var serverForUrlKey = isNativeApp ? null : defaultServer;
    setCredentials(urlKey, serverForUrlKey);
    // Cache wsUrl so index.html doesn't have to fetch /config later.
    api('/api/bridge/config', null, { key: urlKey, server: serverForUrlKey || undefined })
      .then(function (cfg) { if (cfg && cfg.wsUrl) localStorage.setItem('_wsurl', cfg.wsUrl); })
      .catch(function () {})
      .then(function () { location.replace('index.html'); });
    return;
  } else if (state.KEY && (!isNativeApp || localStorage.getItem('_as'))) {
    location.replace('index.html');
    return;
  }

  // Pre-fill if key exists but user navigated back (e.g. logout)
  if (state.KEY) document.getElementById('keyInput').value = state.KEY;

  async function doConnect() {
    var key = document.getElementById('keyInput').value.trim();
    var errEl = document.getElementById('error');
    var btn = document.getElementById('connectBtn');

    var serverUrl = defaultServer;
    if (isNativeApp) {
      serverUrl = (document.getElementById('serverInput').value || '').trim().replace(/\/+$/, '');
      if (!serverUrl) { errEl.textContent = 'Please enter server URL'; errEl.style.display = 'block'; return; }
    }

    if (!key) { errEl.textContent = 'Please enter an API key'; errEl.style.display = 'block'; return; }

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Connecting';
    errEl.style.display = 'none';

    try {
      // devices verifies the key; config returns wsUrl. Run in parallel.
      var results = await Promise.all([
        api('/api/bridge/devices', null, { key: key, server: serverUrl }),
        api('/api/bridge/config', null, { key: key, server: serverUrl }).catch(function () { return null; })
      ]);
      setCredentials(key, serverUrl);
      var cfg = results[1];
      if (cfg && cfg.wsUrl) localStorage.setItem('_wsurl', cfg.wsUrl);
      location.replace('index.html');
    } catch (e) {
      errEl.textContent = e.message && e.message.indexOf('401') === 0 ? 'Invalid API key' : (e.message || 'Connection failed');
      errEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Connect';
    }
  }

  window.doConnect = doConnect;

  function setupScan() {
    var scanBtn = document.getElementById('scanBtn');
    if (!scanBtn) return;
    scanBtn.addEventListener('click', async function () {
      var errEl = document.getElementById('error');
      errEl.style.display = 'none';
      try {
        var mod = await import('@tauri-apps/plugin-barcode-scanner');
        // Request camera permission if not yet granted.
        var perm = await mod.checkPermissions();
        if (perm !== 'granted') {
          perm = await mod.requestPermissions();
          if (perm !== 'granted') {
            errEl.textContent = 'Camera permission denied';
            errEl.style.display = 'block';
            return;
          }
        }
        // Make webview transparent so the camera preview is visible.
        document.body.classList.add('scanning');
        var result = await mod.scan({ windowed: false, formats: [mod.Format.QRCode] });
        document.body.classList.remove('scanning');
        var content = (result && result.content) ? String(result.content).trim() : '';
        if (!content) return;
        applyScannedUrl(content);
      } catch (e) {
        document.body.classList.remove('scanning');
        errEl.textContent = (e && e.message) ? e.message : 'Scan failed';
        errEl.style.display = 'block';
      }
    });
  }

  function applyScannedUrl(raw) {
    var errEl = document.getElementById('error');
    var serverUrl = '';
    var key = '';
    try {
      var u = new URL(raw);
      serverUrl = u.origin;
      key = u.searchParams.get('key') || '';
    } catch (_) {
      // Not a full URL — accept "key=..." or bare key fallback
      var m = raw.match(/[?&]?key=([^&\s]+)/);
      if (m) key = m[1];
    }
    if (!key) {
      errEl.textContent = 'QR code missing key';
      errEl.style.display = 'block';
      return;
    }
    if (serverUrl) document.getElementById('serverInput').value = serverUrl;
    document.getElementById('keyInput').value = key;
    doConnect();
  }
})();
