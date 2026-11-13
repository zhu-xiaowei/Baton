import './theme.js';
// Entry for landing.html — single Start URL field for sign-in.
// A Start URL looks like one of:
//   https://<server>/?t=<token>            (install.sh: 12h, Setup: 10 min; reusable until then)
//   https://<server>/?key=<apiKey>         (older Setup pages)
import { harmonyBridge, harmonyCall } from './harmony.js';
import { state } from './state.js';
import './api.js';
import { initMacosTabs, setNativeTabTitle } from './macos-tabs.js';
import { parseLink, signInWithLink, viaComputer } from './v2/pairing.js';
import { initPageZoomShortcuts } from './page-zoom.js';
import { mountBackButton } from './components/back-button.js';
import { attachPageEdgeBackGesture } from './edge-back.js';
import '../css/back-button.css';

initMacosTabs();
initPageZoomShortcuts();
setNativeTabTitle('Baton');

(function () {
  function releaseNativeSkeleton() {
    var nextFrame = window.requestAnimationFrame || function (fn) { setTimeout(fn, 0); };
    nextFrame(function () {
      nextFrame(function () {
        window.__skelReady = 1;
      });
    });
  }

  // Tauri/native (non-http origin) lets the QR scanner button show, and we
  // accept Start URLs from any origin. Browser is bound to its own origin.
  var isNativeApp = !location.origin.startsWith('http') || location.origin.includes('tauri.localhost');
  var isMobileApp = isNativeApp && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
  var harmonyScan = !!harmonyBridge();

  if (isMobileApp || harmonyScan) {
    var scanBtn = document.getElementById('scanBtn');
    if (scanBtn) scanBtn.style.display = 'flex';
    setupScan();
  }

  var urlParams = new URLSearchParams(location.search);
  var urlToken = urlParams.get('t');
  var urlKey = urlParams.get('key');

  // A pairing link opened in a browser (a phone camera, a pasted link) is handled at once.
  var pageLink = parseLink(location.href);
  if (pageLink) {
    history.replaceState(null, '', location.pathname + location.search);
    releaseNativeSkeleton();
    applyLink(pageLink, !!state.KEY).catch(function (e) { showError(errorMessage(e)); });
    return;
  }

  // Browser auto-login from a Start URL pointing at this origin.
  if (!isNativeApp && (urlToken || urlKey)) {
    showLoading('Connecting');
    var browserServer = location.origin + location.pathname.replace(/\/[^/]*$/, '');
    var prom = urlToken
      ? exchangeToken(browserServer, urlToken).then(function (k) { return routeAfterLogin(k, browserServer); })
      : routeAfterLogin(urlKey, browserServer);
    releaseNativeSkeleton();
    prom.catch(function (e) {
      hideLoading();
      var errEl = document.getElementById('error');
      errEl.textContent = errorMessage(e);
      errEl.style.display = 'block';
    });
    return;
  }

  // Already signed in — for native we additionally need a saved server URL. Settings → Add device
  // opens this page signed in (?add=1).
  var adding = urlParams.has('add');
  if (state.KEY && (!isNativeApp || localStorage.getItem('_as'))) {
    if (!adding) {
      location.replace('index.html');
      return;
    }
  }

  releaseNativeSkeleton();

  if (adding) {
    var leave = function () { if (history.length > 1) history.back(); else location.replace('setup.html'); };
    var back = document.getElementById('addBackButton');
    back.hidden = false;
    mountBackButton(back, leave);
    attachPageEdgeBackGesture(leave, ['.card']);
  }

  // iOS keeps the keyboard open on taps that land on non-focusable areas.
  if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
    document.addEventListener('pointerdown', function (event) {
      var active = document.activeElement;
      if (active?.matches('input') && !event.target.closest('input, button, a, label')) active.blur();
    }, true);
  }

  async function doConnect() {
    var input = document.getElementById('startUrlInput');
    var raw = (input.value || '').trim();
    var errEl = document.getElementById('error');
    var btn = document.getElementById('connectBtn');

    if (!raw) {
      errEl.textContent = 'Please enter your Baton Start URL';
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
    var link = parseLink(raw);
    if (link) return applyLink(link, adding);
    if (adding) throw new Error('Log out first to join another account.');
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
    if (harmonyScan) { setupHarmonyScan(scanBtn); return; }
    // Android Back cancels a scan, otherwise backgrounds the app. Tauri keeps
    // listeners across page loads, so this page registers its own.
    if (window.BatonAndroid) {
      import('@tauri-apps/api/app').then(function (appMod) {
        return appMod.onBackButtonPress(function () {
          if (scanModule) window.__cancelScan();
          else if (adding) history.back();
          else window.BatonAndroid.moveTaskToBack();
        });
      }).catch(function () {});
    }
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
        // injected by main.mm. Android: the system Back listener above cancels.
        var result = await mod.scan({ windowed: false, formats: [mod.Format.QRCode] });
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
        scanModule = null;
        var msg = (e && e.message) ? String(e.message) : '';
        if (/cancel/i.test(msg)) return;
        errEl.textContent = msg || 'Scan failed';
        errEl.style.display = 'block';
      }
    });
  }

  // ScanKit's own UI handles the camera, permission and cancel; a cancel or
  // failure stays silent so the user can retry or paste the Start URL.
  function setupHarmonyScan(scanBtn) {
    scanBtn.addEventListener('click', function () {
      document.getElementById('error').style.display = 'none';
      harmonyCall('scan').then(handleScannedContent, hideLoading);
    });
  }

  // Shared by the HarmonyOS scan path: fill the input and run the login flow.
  async function handleScannedContent(content) {
    var c = (content || '').trim();
    if (!c) return;
    var errEl = document.getElementById('error');
    document.getElementById('startUrlInput').value = c;
    showLoading('Connecting');
    try {
      await applyStartUrl(c);
    } catch (e) {
      hideLoading();
      errEl.textContent = errorMessage(e);
      errEl.style.display = 'block';
    }
  }

  // Called by the native × button on the camera view. Guard against double-tap.
  window.__cancelScan = function () {
    if (cancelInFlight) return;
    if (!scanModule || typeof scanModule.cancel !== 'function') return;
    cancelInFlight = true;
    // Android's cancel never settles the pending scan(), so clear the scan state here.
    scanModule.cancel().catch(function () {}).finally(function () { cancelInFlight = false; scanModule = null; });
  };

  async function exchangeToken(server, token) {
    var url = (server || '').replace(/\/+$/, '') + '/auth/exchange-token';
    var res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token }),
    });
    if (!res.ok) {
      throw new Error(res.status === 401 ? 'Link expired. Get a new one from Setup or re-run deploy.' : 'Connection failed');
    }
    var data = await res.json();
    if (!data || !data.apiKey) throw new Error('Invalid response');
    return data.apiKey;
  }

  // Signed in, only a computer's code is accepted: an online computer of the account adds it. Then
  // home shows it, with Settings and this page gone from the back stack.
  async function applyLink(link, signedIn) {
    showLoading('Connecting');
    if (signedIn) {
      if (link.kind !== 'j') throw new Error('Log out first to join another account.');
      var reply = await viaComputer('pair_approve', { link: link.text });
      return finishAdd(reply.deviceName);
    }
    var result = await signInWithLink(link);
    setCredentials(result.token, link.server);
    if (result.added) return finishAdd(result.added);
    location.replace('index.html');
  }

  function finishAdd(name) {
    sessionStorage.setItem('baton-added', name);
    if (sessionStorage.getItem('baton-add-depth') === '2') { sessionStorage.removeItem('baton-add-depth'); history.go(-2); }
    else location.replace('index.html');
  }

  function showError(text) {
    hideLoading();
    var errEl = document.getElementById('error');
    errEl.textContent = text;
    errEl.style.display = 'block';
  }

  // Validate key + cache wsUrl + route to setup if no devices yet, else index.
  // The /devices call doubles as auth check (401 throws); /config gives wsUrl.
  async function routeAfterLogin(key, server) {
    var serverNorm = server ? server.replace(/\/+$/, '') : null;
    var result = await api('/api/bridge/devices', null, { key: key, server: serverNorm || undefined });
    setCredentials(key, isNativeApp ? serverNorm : null);
    var devs = result && result.devices;
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
