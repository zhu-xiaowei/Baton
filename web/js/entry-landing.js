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
    btn.textContent = 'Connecting...';
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
})();
