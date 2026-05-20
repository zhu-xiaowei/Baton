// Entry for landing.html — single Start URL field for sign-in.
// A Start URL looks like one of:
//   https://<server>/?t=<one-time-token>   (issued by install.sh, 60 min single-use)
//   https://<server>/?key=<apiKey>         (issued by setup page, permanent)
import { state } from './state.js';
import './api.js';

(function () {
  // Tauri/native (non-http origin) lets the QR scanner button show, and we
  // accept Start URLs from any origin. Browser is bound to its own origin.
  var isNativeApp = !location.origin.startsWith('http') || location.origin.includes('tauri.localhost');

  if (isNativeApp) {
    var scanBtn = document.getElementById('scanBtn');
    if (scanBtn) scanBtn.style.display = 'flex';
    setupScan();
  }

  var urlParams = new URLSearchParams(location.search);
  var urlToken = urlParams.get('t');
  var urlKey = urlParams.get('key');

  // Browser auto-login from a Start URL pointing at this origin.
  if (!isNativeApp && (urlToken || urlKey)) {
    showLoading('Connecting');
    var browserServer = location.origin + location.pathname.replace(/\/[^/]*$/, '');
    var prom = urlToken
      ? exchangeToken(browserServer, urlToken).then(function (k) { return routeAfterLogin(k, browserServer); })
      : routeAfterLogin(urlKey, browserServer);
    prom.catch(function (e) {
      hideLoading();
      var errEl = document.getElementById('error');
      errEl.textContent = errorMessage(e);
      errEl.style.display = 'block';
    });
    return;
  }

  // Already signed in — for native we additionally need a saved server URL.
  if (state.KEY && (!isNativeApp || localStorage.getItem('_as'))) {
    location.replace('index.html');
    return;
  }

  async function doConnect() {
    var input = document.getElementById('startUrlInput');
    var raw = (input.value || '').trim();
    var errEl = document.getElementById('error');
    var btn = document.getElementById('connectBtn');

    if (!raw) {
      errEl.textContent = 'Please enter your AgentPeek Start URL';
      errEl.style.display = 'block';
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Connecting';
    errEl.style.display = 'none';

    try {
      await applyStartUrl(raw);
    } catch (e) {
      errEl.textContent = errorMessage(e);
      errEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Connect';
    }
  }

  window.doConnect = doConnect;

  // Parse a Start URL and route through the matching login flow.
  // Throws on malformed input or auth failure (caller handles UI).
  async function applyStartUrl(raw) {
    var server = '';
    var token = '';
    var key = '';
    try {
      var u = new URL(raw);
      server = u.origin;
      token = u.searchParams.get('t') || '';
      key = u.searchParams.get('key') || '';
    } catch (_) {
      throw new Error('Invalid Start URL');
    }
    if (!token && !key) throw new Error('Start URL is missing ?t= or ?key=');

    if (token) {
      var apiKey = await exchangeToken(server, token);
      await routeAfterLogin(apiKey, server);
    } else {
      await routeAfterLogin(key, server);
    }
  }

  var scanModule = null;
  var cancelInFlight = false;
  function setupScan() {
    var scanBtn = document.getElementById('scanBtn');
    if (!scanBtn) return;
    scanBtn.addEventListener('click', async function () {
      var errEl = document.getElementById('error');
      errEl.style.display = 'none';
      try {
        var mod = await import('@tauri-apps/plugin-barcode-scanner');
        scanModule = mod;
        cancelInFlight = false;
        var perm = await mod.checkPermissions();
        if (perm !== 'granted') {
          perm = await mod.requestPermissions();
          if (perm !== 'granted') {
            errEl.textContent = 'Camera permission denied';
            errEl.style.display = 'block';
            return;
          }
        }
        // windowed:false → camera fully covers the webview. iOS: native × button
        // injected by main.mm. Android: system back button cancels via onBackButtonPress.
        var backListener = null;
        try {
          var appMod = await import('@tauri-apps/api/app');
          backListener = await appMod.onBackButtonPress(function () { window.__cancelScan(); });
        } catch (_) {}
        var result = await mod.scan({ windowed: false, formats: [mod.Format.QRCode] });
        if (backListener) backListener.unregister();
        scanModule = null;
        var content = (result && result.content) ? String(result.content).trim() : '';
        if (!content) return;
        document.getElementById('startUrlInput').value = content;
        showLoading('Connecting');
        applyStartUrl(content).catch(function (e) {
          hideLoading();
          errEl.textContent = errorMessage(e);
          errEl.style.display = 'block';
        });
      } catch (e) {
        if (backListener) backListener.unregister();
        scanModule = null;
        var msg = (e && e.message) ? String(e.message) : '';
        if (/cancel/i.test(msg)) return;
        errEl.textContent = msg || 'Scan failed';
        errEl.style.display = 'block';
      }
    });
  }

  // Called by the native × button on the camera view. Guard against double-tap.
  window.__cancelScan = function () {
    if (cancelInFlight) return;
    if (!scanModule || typeof scanModule.cancel !== 'function') return;
    cancelInFlight = true;
    scanModule.cancel().catch(function () {}).finally(function () { cancelInFlight = false; });
  };

  async function exchangeToken(server, token) {
    var url = (server || '').replace(/\/+$/, '') + '/auth/exchange-token';
    var res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token }),
    });
    if (!res.ok) {
      throw new Error(res.status === 401 ? 'Link expired or already used. Re-run deploy to get a new link.' : 'Connection failed');
    }
    var data = await res.json();
    if (!data || !data.apiKey) throw new Error('Invalid response');
    return data.apiKey;
  }

  // Validate key + cache wsUrl + route to setup if no devices yet, else index.
  // The /devices call doubles as auth check (401 throws); /config gives wsUrl.
  async function routeAfterLogin(key, server) {
    var serverNorm = server ? server.replace(/\/+$/, '') : null;
    var results = await Promise.all([
      api('/api/bridge/devices', null, { key: key, server: serverNorm || undefined }),
      api('/api/bridge/config', null, { key: key, server: serverNorm || undefined }).catch(function () { return null; }),
    ]);
    setCredentials(key, isNativeApp ? serverNorm : null);
    var cfg = results[1];
    if (cfg && cfg.wsUrl) localStorage.setItem('_wsurl', cfg.wsUrl);
    var devs = results[0] && results[0].devices;
    var hasDevices = Array.isArray(devs) && devs.length > 0;
    location.replace(hasDevices ? 'index.html' : 'setup.html');
  }

  function errorMessage(e) {
    var msg = e && e.message ? String(e.message) : '';
    if (msg.indexOf('401') === 0) return 'Invalid API key';
    return msg || 'Connection failed';
  }

  function showLoading(text) {
    var btn = document.getElementById('connectBtn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>' + text;
    }
  }

  function hideLoading() {
    var btn = document.getElementById('connectBtn');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Connect';
    }
  }
})();
