import { mountThemeSettings } from './theme.js';
// Entry for setup.html — install command + Start URL QR
import { state } from './state.js';
import './api.js';
import { mountBackButton } from './components/back-button.js';
import { attachPageEdgeBackGesture } from './edge-back.js';
import '../css/back-button.css';
import qrcode from 'qrcode-generator';
import { initSystemBack } from './system-back.js';
import { initMacosTabs, setNativeTabTitle } from './macos-tabs.js';
import { initMobileNotifications, mountNotificationSettings } from './mobile-notifications.js';
import { mountTextSizeSettings } from './text-size-settings.js';
import { initPageZoomShortcuts } from './page-zoom.js';

initMacosTabs();
initPageZoomShortcuts();
setNativeTabTitle('Settings');

(function () {
  // Auth guard: handle ?key= URL param, redirect if missing key
  var urlKey = new URLSearchParams(location.search).get('key');
  if (urlKey) {
    setCredentials(urlKey, location.origin + location.pathname.replace(/\/[^/]*$/, ''));
    history.replaceState(null, '', location.pathname);
  }
  if (!state.KEY) { location.replace('landing.html'); return; }
  mountTextSizeSettings();
  mountNotificationSettings();
  void initMobileNotifications();
  mountThemeSettings();

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

  // Steps 1-3 share one 10-minute token, so the install command, Start URL and QR code never
  // carry the API key.
  var cmdEl = document.getElementById('installCmdText');
  var platform = /Win/.test(navigator.platform) ? 'windows' : 'unix';
  var token = '';

  function renderInstallCommand() {
    var windows = platform === 'windows';
    if (token) {
      var url = state.SERVER + '/auth/install?t=' + token;
      cmdEl.textContent = windows ? "irm '" + url + "&platform=windows' | iex" : 'curl -sL "' + url + '" | bash';
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

  async function refreshToken() {
    var expiry = '';
    try {
      var result = await apiPost('/api/auth/start-token');
      token = result.token;
      expiry = 'Valid for ' + Math.round(result.expiresIn / 60) + ' minutes.';
    } catch (e) {
      token = '';
      expiry = 'Could not create a link. Reopen this page to try again.';
    }
    document.querySelectorAll('.token-expiry').forEach(function (el) { el.textContent = expiry; });
    renderInstallCommand();
    if (!token) {
      cmdEl.textContent = 'Could not create an install command.';
      document.getElementById('qrUrl').textContent = 'Could not create a Start URL.';
      document.getElementById('qrCanvas').parentElement.classList.remove('ready');
      return;
    }
    var startUrl = state.SERVER + '/?t=' + token;
    document.getElementById('qrUrl').textContent = startUrl;
    drawQr(startUrl);
  }
  renderInstallCommand();
  refreshToken();

  function copyText(btn, text) {
    navigator.clipboard.writeText(text).then(function () {
      btn.textContent = '✓';
      btn.classList.add('copied');
      setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
    });
  }
  function copyCmd(btn) { copyText(btn, document.getElementById('installCmdText').textContent); }
  function copyUrl(btn) { copyText(btn, document.getElementById('qrUrl').textContent); }

  window.copyCmd = copyCmd;
  window.copyUrl = copyUrl;

  attachPageEdgeBackGesture(leaveSetup, ['.setup-bar', '.setup-content']);

  // App version — baked at build time from package.json, shown on all platforms.
  var verEl = document.getElementById('appVersion');
  if (verEl && typeof __APP_VERSION__ !== 'undefined') {
    verEl.textContent = 'v' + __APP_VERSION__;
    verEl.style.display = 'block';

    // Native shells show the installed package's version and build number.
    var harmony = window.harmonyBridge;
    if (harmony && typeof harmony.appVersion === 'function') {
      try {
        var installed = JSON.parse(harmony.appVersion());
        if (installed.versionCode) {
          verEl.textContent = 'v' + (installed.versionName || __APP_VERSION__) + ' (' + installed.versionCode + ')';
        }
      } catch (_) {}
    } else if (window.__TAURI_INTERNALS__) {
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
