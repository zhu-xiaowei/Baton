// Entry for setup.html — install command + Start URL QR
import { state } from './state.js';
import './api.js';
import { mountBackButton } from './components/back-button.js';
import { attachPageEdgeBackGesture } from './edge-back.js';
import '../css/back-button.css';
import qrcode from 'qrcode-generator';
import { initSystemBack } from './system-back.js';
import { initMacosTabs, setNativeTabTitle } from './macos-tabs.js';

initMacosTabs();
setNativeTabTitle('Settings');

(function () {
  // Auth guard: handle ?key= URL param, redirect if missing key
  var urlKey = new URLSearchParams(location.search).get('key');
  if (urlKey) {
    setCredentials(urlKey, location.origin + location.pathname.replace(/\/[^/]*$/, ''));
    history.replaceState(null, '', location.pathname);
  }
  if (!state.KEY) { location.replace('landing.html'); return; }

  function leaveSetup() {
    if (!(window.isTauri || window.__TAURI_INTERNALS__)) {
      location.href = 'index.html';
      return;
    }
    sessionStorage.setItem('baton-returning-home', '1');
    var referrer = document.referrer ? new URL(document.referrer) : null;
    var fromIndex = referrer && referrer.origin === location.origin
      && /\/(?:index\.html)?$/.test(referrer.pathname);
    if (fromIndex && history.length > 1) history.back();
    else location.href = 'index.html';
  }

  mountBackButton(document.getElementById('setupBackButton'), leaveSetup);
  initSystemBack({ navigate: () => { leaveSetup(); return true; } });

  // Step 1: Install command — carries a single-use pairing code, never a reusable key.
  var cmdEl = document.getElementById('installCmdText');
  var platform = /Win/.test(navigator.platform) ? 'windows' : 'unix';
  var installKey = '';

  function minutes(seconds) {
    return Math.max(1, Math.round(seconds / 60)) + ' minutes';
  }

  function renderInstallCommand() {
    var windows = platform === 'windows';
    if (installKey) {
      cmdEl.textContent = windows
        ? "irm -Headers @{'x-api-key'='" + installKey + "'} '" + state.SERVER + "/api/install?platform=windows' | iex"
        : 'curl -sL -H "x-api-key: ' + installKey + '" "' + state.SERVER + '/api/install" | bash';
    }
    document.getElementById('installHint').textContent = windows
      ? 'Run this command in PowerShell with Node.js installed.'
      : 'Run this command on macOS or Linux with Node.js installed.';
    document.querySelectorAll('.platform-option').forEach(function (button) {
      button.classList.toggle('active', button.dataset.platform === platform);
    });
  }

  window.selectInstallPlatform = function (value) {
    platform = value;
    renderInstallCommand();
  };

  // Older servers have no pairing endpoint; they still accept the stored key.
  async function newInstallCommand() {
    var button = document.getElementById('newInstallCmd');
    button.disabled = true;
    try {
      var pairing = await apiPost('/api/auth/bridge-pairing');
      installKey = pairing.code;
      document.getElementById('installExpiry').textContent = 'Single use, valid for ' + minutes(pairing.expiresIn) + '.';
      button.hidden = false;
    } catch (e) {
      installKey = state.KEY;
      document.getElementById('installExpiry').textContent = '';
    }
    button.disabled = false;
    renderInstallCommand();
  }
  window.newInstallCommand = newInstallCommand;
  renderInstallCommand();
  newInstallCommand();

  // Steps 2 + 3: Start URL and its QR code, backed by a single-use token.
  function drawQr(startUrl) {
    var qr = qrcode(0, 'M');
    qr.addData(startUrl);
    qr.make();

    var canvas = document.getElementById('qrCanvas');
    var size = 200;
    var cellSize = size / qr.getModuleCount();
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000000';
    for (var r = 0; r < qr.getModuleCount(); r++) {
      for (var c = 0; c < qr.getModuleCount(); c++) {
        if (qr.isDark(r, c)) {
          ctx.fillRect(c * cellSize, r * cellSize, cellSize + 0.5, cellSize + 0.5);
        }
      }
    }
    canvas.parentElement.classList.add('ready');
  }

  async function newStartUrl() {
    var button = document.getElementById('newStartUrl');
    button.disabled = true;
    var startUrl;
    try {
      var start = await apiPost('/api/auth/start-token');
      startUrl = state.SERVER + '/?t=' + encodeURIComponent(start.token);
      document.getElementById('startUrlExpiry').textContent = 'Single use, valid for ' + minutes(start.expiresIn) + '.';
      button.hidden = false;
    } catch (e) {
      startUrl = state.SERVER + '/?key=' + encodeURIComponent(state.KEY);
    }
    button.disabled = false;
    document.getElementById('qrUrl').textContent = startUrl;
    drawQr(startUrl);
  }
  window.newStartUrl = newStartUrl;
  newStartUrl();

  // Step 4: Authorized devices.
  function timeAgo(seconds) {
    if (!seconds) return 'never';
    var diff = Math.max(0, Date.now() / 1000 - seconds);
    if (diff < 3600) return 'within the last hour';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  function credentialRow(credential) {
    var row = document.createElement('div');
    row.className = 'cred-row';
    var info = document.createElement('div');
    info.className = 'cred-info';
    var name = document.createElement('div');
    name.className = 'cred-name';
    var nameText = document.createElement('span');
    nameText.className = 'cred-name-text';
    nameText.textContent = credential.kind === 'master' ? 'Master key'
      : credential.name || (credential.kind === 'bridge' ? 'Bridge' : 'App');
    name.appendChild(nameText);
    if (credential.current) {
      var tag = document.createElement('span');
      tag.className = 'cred-tag';
      tag.textContent = 'This device';
      name.appendChild(tag);
    }
    var meta = document.createElement('div');
    meta.className = 'cred-meta';
    var kind = credential.kind === 'bridge'
      ? 'Bridge · ' + (credential.device || 'not connected yet')
      : credential.kind === 'master' ? 'Install, sign-in links' : 'App';
    meta.textContent = kind + ' · used ' + timeAgo(credential.lastUsedAt);
    info.append(name, meta);
    var action = document.createElement('button');
    action.className = 'cred-action';
    action.textContent = credential.kind === 'master' ? 'Rotate' : 'Revoke';
    action.onclick = function () {
      if (credential.kind === 'master') rotateMasterKey(action);
      else revokeCredential(credential, action);
    };
    row.append(info, action);
    return row;
  }

  async function loadCredentials() {
    try {
      var data = await api('/api/auth/credentials');
      var list = document.getElementById('credentialList');
      list.replaceChildren.apply(list, data.credentials.map(credentialRow));
      document.getElementById('credentialsSection').hidden = false;
    } catch (e) {}
  }

  async function revokeCredential(credential, button) {
    var label = credential.name || credential.device || 'this credential';
    var message = credential.current
      ? 'Revoke this device? You will be signed out here.'
      : 'Revoke ' + label + '? It is disconnected immediately and must be set up again.';
    if (!confirm(message)) return;
    button.disabled = true;
    try {
      await apiPost('/api/auth/revoke', { id: credential.id });
      if (credential.current) { logout(); return; }
      await loadCredentials();
    } catch (e) {
      button.disabled = false;
      alert('Revoke failed: ' + e.message);
    }
  }

  async function rotateMasterKey(button) {
    if (!confirm('Rotate the master key? The old key stops working everywhere it was used, including old Start URLs. Devices listed here stay signed in.')) return;
    button.disabled = true;
    try {
      var rotated = await apiPost('/api/auth/rotate-master');
      if (state.KEY.indexOf('bt_') !== 0) setCredentials(rotated.masterKey, null, state.ACCOUNT, true);
      document.getElementById('masterKeyText').textContent = rotated.masterKey;
      document.getElementById('masterKeyResult').hidden = false;
      await loadCredentials();
    } catch (e) {
      button.disabled = false;
      alert('Rotation failed: ' + e.message);
    }
  }
  loadCredentials();

  function copyText(btn, text) {
    navigator.clipboard.writeText(text).then(function () {
      btn.textContent = '✓';
      btn.classList.add('copied');
      setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
    });
  }
  function copyCmd(btn) { copyText(btn, document.getElementById('installCmdText').textContent); }
  function copyUrl(btn) { copyText(btn, document.getElementById('qrUrl').textContent); }
  function copyMasterKey(btn) { copyText(btn, document.getElementById('masterKeyText').textContent); }

  window.copyCmd = copyCmd;
  window.copyUrl = copyUrl;
  window.copyMasterKey = copyMasterKey;

  attachPageEdgeBackGesture(leaveSetup, ['.setup-bar', '.setup-content']);

  // App version — baked at build time from package.json, shown on all platforms.
  var verEl = document.getElementById('appVersion');
  if (verEl && typeof __APP_VERSION__ !== 'undefined') {
    verEl.textContent = 'v' + __APP_VERSION__;
    verEl.style.display = 'block';

    // On iOS, use the build number from the installed app bundle so the
    // display always matches the archive that produced this app.
    if (window.__TAURI_INTERNALS__) {
      import('@tauri-apps/api/core').then(function (core) {
        return core.invoke('ios_build_number');
      }).then(function (buildNumber) {
        if (buildNumber) {
          verEl.textContent = 'v' + __APP_VERSION__ + ' (' + buildNumber + ')';
        }
      }).catch(function () {});
    }
  }
})();
