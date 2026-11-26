// The Start URL form: first sign-in (landing.html) and Add device (add-device.js).
// A Start URL looks like one of:
//   https://<server>/?t=<token>            (install.sh: 12h, Setup: 15 min; reusable until then)
//   https://<server>/?key=<apiKey>         (older Setup pages)
import { harmonyBridge, harmonyCall } from '../harmony.js';
import { state } from '../state.js';
import '../api.js';
import { parseLink, recoverAccount, signInWithLink, viaComputer } from './pairing.js';
import { fromPhrase } from './recovery.js';
import '../../css/start-url.css';

// Tauri/native (non-http origin) shows the QR scanner and accepts Start URLs from any origin.
export const isNativeApp = !location.origin.startsWith('http') || location.origin.includes('tauri.localhost');
const touch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

const SCAN_ICON = '<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">'
  + '<path d="M192 416C172.8 416 160 403.2 160 384L160 256c0-51.2 44.8-96 96-96l128 0c19.2 0 32 12.8 32 32S403.2 224 384 224L256 224C236.8 224 224 236.8 224 256l0 128C224 403.2 211.2 416 192 416z"/>'
  + '<path d="M384 864 256 864c-51.2 0-96-44.8-96-96l0-128c0-19.2 12.8-32 32-32S224 620.8 224 640l0 128c0 19.2 12.8 32 32 32l128 0c19.2 0 32 12.8 32 32S403.2 864 384 864z"/>'
  + '<path d="M768 864l-128 0c-19.2 0-32-12.8-32-32s12.8-32 32-32l128 0c19.2 0 32-12.8 32-32l0-128c0-19.2 12.8-32 32-32s32 12.8 32 32l0 128C864 819.2 819.2 864 768 864z"/>'
  + '<path d="M832 416c-19.2 0-32-12.8-32-32L800 256c0-19.2-12.8-32-32-32l-128 0C620.8 224 608 211.2 608 192S620.8 160 640 160l128 0c51.2 0 96 44.8 96 96l0 128C864 403.2 851.2 416 832 416z"/>'
  + '<path d="M832 544 192 544C172.8 544 160 531.2 160 512S172.8 480 192 480l640 0c19.2 0 32 12.8 32 32S851.2 544 832 544z"/>'
  + '</svg>';

const HELP_LINK = '<a class="field-help" href="https://agentbaton.app" target="_blank" rel="noopener" data-external'
  + ' aria-label="Where to get a Start URL" title="Where to get a Start URL"><svg viewBox="0 0 24 24" fill="none"'
  + ' stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/>'
  + '<path d="M12 11v5M12 8h.01"/></svg></a>';

const MARKUP = '<div class="logo"><img src="assets/baton-logo.svg" alt=""></div>'
  + '<h1>Baton</h1><p class="tagline">Your agents, anywhere.</p>'
  + '<div class="input-group"><label>Start URL</label><div class="start-url-row">'
  + '<input type="url" placeholder="Paste your Baton Start URL" autocomplete="off">'
  + '<button type="button" class="scan-btn" aria-label="Scan QR code" title="Scan QR code" hidden>' + SCAN_ICON + '</button>'
  + '</div></div>'
  + '<button type="button" class="btn">Connect</button><div class="error"></div>';

// iOS keeps the keyboard open on taps that land on non-focusable areas.
if (touch) {
  document.addEventListener('pointerdown', function (event) {
    var active = document.activeElement;
    if (active?.matches('input') && !event.target.closest('input, button, a, label')) active.blur();
  }, true);
}

export async function exchangeToken(server, token) {
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

// Validate key + cache wsUrl + route to setup if no devices yet, else index.
// The /devices call doubles as auth check (401 throws); /config gives wsUrl.
export async function routeAfterLogin(key, server) {
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

// adding: signed in, Add device. onAdded runs after a computer was added (default: home).
export function mountStartUrlForm(root, { adding = false, onAdded } = {}) {
  root.classList.add('start-url-form');
  root.innerHTML = MARKUP;
  if (!adding) root.querySelector('label').insertAdjacentHTML('beforeend', HELP_LINK);
  var input = root.querySelector('input');
  var btn = root.querySelector('.btn');
  var errEl = root.querySelector('.error');
  var scanBtn = root.querySelector('.scan-btn');
  var harmonyScan = !!harmonyBridge();
  var scanModule = null;
  var cancelInFlight = false;

  function showLoading(text) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>' + text;
    errEl.style.display = 'none';
  }

  function showError(text) {
    btn.disabled = false;
    btn.textContent = 'Connect';
    errEl.textContent = text;
    errEl.style.display = 'block';
  }

  function attempt(task) {
    showLoading('Connecting');
    return Promise.resolve().then(task).catch(function (e) { showError(errorMessage(e)); });
  }

  // Parse a Start URL and route through the matching login flow.
  async function applyStartUrl(raw) {
    var link = parseLink(raw);
    if (link) return applyLink(link, adding);
    if (adding) throw new Error('Log out first to join another account.');
    if (raw.trim().split(/\s+/).length === 24) {
      var k = await fromPhrase(raw);
      if (!k) throw new Error('Check the recovery phrase: a word is wrong or missing.');
      var recoveryServer = localStorage.getItem('_as') || localStorage.getItem('_ls') || state.SERVER;
      setCredentials(await recoverAccount(recoveryServer, k), recoveryServer);
      location.replace('index.html');
      return;
    }
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
    await routeAfterLogin(token ? await exchangeToken(server, token) : key, server);
  }

  // Signed in, only a computer's code is accepted: an online computer of the account adds it.
  async function applyLink(link, signedIn) {
    if (signedIn) {
      if (link.kind !== 'j') throw new Error('This code adds a new phone. To move that computer to your account, run `~/.baton-bridge/baton leave` on it (Windows PowerShell: `~\\.baton-bridge\\baton.cmd leave`; cmd: `%USERPROFILE%\\.baton-bridge\\baton.cmd leave`) and scan the new code.');
      var reply = await viaComputer('pair_approve', { link: link.text });
      return finishAdd(reply.deviceName, reply.displayName);
    }
    var result = await signInWithLink(link);
    setCredentials(result.token, result.server);
    if (result.added) return finishAdd(result.added, result.addedName);
    location.replace('index.html');
  }

  function finishAdd(name, label) {
    if (!root.isConnected) return; // closed while connecting
    sessionStorage.setItem('baton-added', name);
    sessionStorage.setItem('baton-added-name', label || name);
    if (onAdded) onAdded();
    else location.replace('index.html');
  }

  function connectScanned(content) {
    var c = content ? String(content).trim() : '';
    if (!c) return;
    input.value = c;
    attempt(function () { return applyStartUrl(c); });
  }

  btn.addEventListener('click', function () {
    var raw = (input.value || '').trim();
    if (!raw) { showError('Please enter your Baton Start URL'); return; }
    attempt(function () { return applyStartUrl(raw); });
  });
  input.addEventListener('keydown', function (event) { if (event.key === 'Enter') btn.click(); });

  if ((isNativeApp && touch) || harmonyScan) {
    scanBtn.hidden = false;
    // ScanKit's own UI handles the camera, permission and cancel; a cancel or
    // failure stays silent so the user can retry or paste the Start URL.
    if (harmonyScan) scanBtn.addEventListener('click', function () {
      errEl.style.display = 'none';
      harmonyCall('scan').then(connectScanned, function () {});
    });
    else scanBtn.addEventListener('click', async function () {
      errEl.style.display = 'none';
      try {
        var mod = await import('@tauri-apps/plugin-barcode-scanner');
        scanModule = mod;
        cancelInFlight = false;
        var perm = await mod.checkPermissions();
        if (perm !== 'granted') {
          perm = await mod.requestPermissions();
          if (perm !== 'granted') { scanModule = null; showError('Camera permission denied'); return; }
        }
        // windowed:false → camera fully covers the webview. iOS: native × button
        // injected by main.mm. Android: the system Back cancels (cancelScan).
        var result = await mod.scan({ windowed: false, formats: [mod.Format.QRCode] });
        scanModule = null;
        connectScanned(result && result.content);
      } catch (e) {
        scanModule = null;
        var msg = (e && e.message) ? String(e.message) : '';
        if (!/cancel/i.test(msg)) showError(msg || 'Scan failed');
      }
    });
    // Tauri keeps listeners across page loads, so the sign-in page registers its own Back;
    // Add device is closed by the page's system back (it calls cancelScan first).
    if (window.BatonAndroid && !adding) {
      import('@tauri-apps/api/app').then(function (appMod) {
        return appMod.onBackButtonPress(function () {
          if (!cancelScan()) window.BatonAndroid.moveTaskToBack();
        });
      }).catch(function () {});
    }
  }

  // Called by the native × button on the camera view. Guard against double-tap.
  function cancelScan() {
    if (!scanModule) return false;
    if (cancelInFlight || typeof scanModule.cancel !== 'function') return true;
    cancelInFlight = true;
    // Android's cancel never settles the pending scan(), so clear the scan state here.
    scanModule.cancel().catch(function () {}).finally(function () { cancelInFlight = false; scanModule = null; });
    return true;
  }
  window.__cancelScan = cancelScan;

  return { attempt, applyLink, cancelScan };
}
