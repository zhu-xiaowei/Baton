import { mountThemeSettings } from './theme.js';
// Entry for setup.html — install command + Start URL QR
import { state } from './state.js';
import './api.js';
import { mountBackButton } from './components/back-button.js';
import { attachPageEdgeBackGesture } from './edge-back.js';
import '../css/back-button.css';
import qrcode from 'qrcode-generator';
import { initSystemBack } from './system-back.js';
import { CHECK_ICON_SVG } from './components/icons.js';
import { initMacosTabs, setNativeTabTitle } from './macos-tabs.js';
import { initMobileNotifications, mountNotificationSettings } from './mobile-notifications.js';
import { mountTextSizeSettings } from './text-size-settings.js';
import { initPageZoomShortcuts } from './page-zoom.js';
import { removeApp, viaComputer } from './v2/pairing.js';
import { devices } from './v2/direct-transport.js';
import { toPhrase } from './v2/recovery.js';
import { confirmDialog } from './components/confirm-dialog.js';
import { fromBase64 } from '../../bridge/direct-rpc-protocol.mjs';

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

  // The scan icon shows where Add device can scan: the phone apps (as on the sign-in page).
  var nativeApp = !location.origin.startsWith('http') || location.origin.includes('tauri.localhost');
  if ((nativeApp && ('ontouchstart' in window || navigator.maxTouchPoints > 0)) || window.harmonyBridge) {
    document.querySelector('.add-device .scan-icon').hidden = false;
  }

  // After adding, the sign-in page returns to home past this page when home opened it.
  document.querySelector('.add-device').addEventListener('click', function () {
    var referrer = document.referrer ? new URL(document.referrer) : null;
    var fromIndex = referrer && referrer.origin === location.origin && /\/(?:index\.html)?$/.test(referrer.pathname);
    sessionStorage.setItem('baton-add-depth', fromIndex && history.length > 2 ? '2' : '0');
  });

  // A paired account's own actions (design §7, §9).
  var paired = state.KEY.indexOf('bt_') === 0;
  // Only an account created by pairing has a recovery phrase, deletion and Apps to remove; a paired App
  // of a self-hosted (API-key) account does not.
  var listing = null;
  if (paired) devices().then(function (body) { listing = body; document.querySelector('.account-actions').hidden = !body.hosted; }, function () {});

  // Text content only (the device's own name); never inside an attribute.
  function esc(text) { var el = document.createElement('span'); el.textContent = text; return el.innerHTML; }

  function renderApps() {
    var apps = (listing && listing.apps || []).filter(function (app) { return app.kind === 'app'; });
    document.getElementById('appsList').innerHTML = apps.map(function (app) {
      var seen = app.lastSeen ? new Date(app.lastSeen * 1000).toLocaleString() : '';
      return '<div class="agent-thread-row"><span class="agent-thread-copy"><span class="agent-thread-title"><strong>' + esc(app.deviceName)
        + '</strong></span><span class="agent-thread-meta"><small>' + esc(seen) + '</small></span></span>'
        + (app.id === listing.self ? '<span class="app-self">This device</span>'
          : '<button class="app-remove" type="button" data-id="' + app.id + '">Remove</button>')
        + '</div>';
    }).join('');
  }

  window.openAppsSheet = function () {
    var sheet = document.getElementById('appsSheet');
    renderApps();
    sheet.style.display = 'flex';
    void sheet.offsetWidth;
    sheet.classList.add('open');
    devices().then(function (body) { listing = body; renderApps(); }, function () {});
  };

  window.closeAppsSheet = function () {
    var sheet = document.getElementById('appsSheet');
    sheet.classList.remove('open');
    setTimeout(function () { if (!sheet.classList.contains('open')) sheet.style.display = 'none'; }, 320);
  };

  // A lost phone or browser: its token stops and the account key is replaced, as for a computer.
  document.getElementById('appsList').addEventListener('click', async function (event) {
    var button = event.target.closest('.app-remove');
    // The name comes from the listing, never from markup: a device picks its own name.
    var app = button && listing.apps.find(function (candidate) { return candidate.id === button.dataset.id; });
    if (!app || !await confirmDialog('Remove ' + app.deviceName + '?', [[false, 'Cancel'], [true, 'Remove', true]], false,
      'It is signed out at once and cannot reach your computers again; to use it again, add it with a new code.')) return;
    button.disabled = true;
    try {
      await removeApp(button.dataset.id);
      listing = await devices();
      renderApps();
    } catch (e) {
      button.disabled = false;
      await confirmDialog('Could not remove it', [[true, 'OK', true]], true, e.message);
    }
  });

  window.showRecoveryPhrase = async function () {
    if (!await confirmDialog('Show recovery phrase?', [[false, 'Cancel'], [true, 'Show', true]], false,
      'Anyone with these 24 words can reach your computers. Keep them private; removing a computer changes them.')) return;
    try {
      var reply = await viaComputer('recovery_key');
      await confirmDialog('Recovery phrase', [[true, 'Done', true]], true, await toPhrase(fromBase64(reply.k)));
    } catch (e) {
      await confirmDialog('Could not show the phrase', [[true, 'OK', true]], true, e.message);
    }
  };

  window.deleteAccount = async function () {
    if (!await confirmDialog('Delete account?', [[false, 'Cancel'], [true, 'Delete', true]], false,
      'Every device leaves the account and its Bridge uninstalls itself; files on your computers are kept.')) return;
    try {
      await apiPost('/api/account/delete');
      logout();
    } catch (e) {
      await confirmDialog('Could not delete the account', [[true, 'OK', true]], true, e.message);
    }
  };

  mountBackButton(document.getElementById('setupBackButton'), leaveSetup);
  initSystemBack({ navigate: () => { leaveSetup(); return true; } });

  // One 10-minute code serves the three tabs, requested only when one of them is shown. With the API
  // key it is a start token, so the key never appears in the install command, Start URL or QR code; a
  // paired App (device token) gets a one-use invite that an online computer seals K into.
  var platform = /Win/.test(navigator.platform) ? 'windows' : 'unix';
  var tokenRequest = null;

  function startToken() {
    tokenRequest = tokenRequest || (paired ? viaComputer('pair_invite') : apiPost('/api/auth/start-token')).then(function (result) {
      setTimeout(resetConnect, result.expiresIn * 1000);
      return paired ? result.link : state.SERVER + '/?t=' + result.token;
    }, function (error) { tokenRequest = null; throw error; });
    return tokenRequest;
  }

  function installCommand(startUrl) {
    var url = paired ? state.SERVER + '/install' : startUrl.replace('/?t=', '/auth/install?t=');
    var windows = platform === 'windows';
    if (paired) return windows ? "irm '" + url + "?platform=windows' | iex" : 'curl -sL ' + url + ' | bash';
    return windows ? "irm '" + url + "&platform=windows' | iex" : 'curl -sL "' + url + '" | bash';
  }

  function connectText(panel, startUrl) {
    return panel === 'url' ? startUrl : installCommand(startUrl);
  }

  function resetConnect() {
    tokenRequest = null;
    document.querySelectorAll('.connect .code-block').forEach(function (block) {
      var btn = block.querySelector('.code-btn');
      block.classList.add('masked');
      block.querySelector('.text').textContent = '••••••••••••••••••••••••••••••••';
      if (btn.dataset.icon) btn.innerHTML = btn.dataset.icon;
    });
    document.querySelector('.connect .qr-frame').classList.remove('ready');
    if (!document.querySelector('[data-panel="qr"]').hidden) showQr();
  }

  window.revealConnect = function (btn) {
    var block = btn.parentElement;
    if (!block.classList.contains('masked')) { copyText(btn, block.querySelector('.text').textContent); return; }
    btn.dataset.icon = btn.dataset.icon || btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span>';
    btn.disabled = true;
    // A paired App's install command needs no code.
    (paired && block.dataset.panel === 'install' ? Promise.resolve('') : startToken()).then(function (startUrl) {
      block.querySelector('.text').textContent = connectText(block.dataset.panel, startUrl);
      block.classList.remove('masked');
      btn.textContent = 'Copy';
    }, function () { btn.innerHTML = btn.dataset.icon; }).finally(function () { btn.disabled = false; });
  };

  function showQr() {
    if (document.querySelector('.connect .qr-frame.ready')) return;
    startToken().then(drawQr, function () {});
  }

  window.selectConnectTab = function (tab) {
    document.querySelectorAll('.connect-tabs .platform-option').forEach(function (button) {
      button.classList.toggle('active', button.dataset.tab === tab);
    });
    document.querySelectorAll('.connect [data-panel]').forEach(function (panel) { panel.hidden = panel.dataset.panel !== tab; });
    if (tab === 'qr') showQr();
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

  function copyText(btn, text) {
    navigator.clipboard.writeText(text).then(function () {
      btn.innerHTML = CHECK_ICON_SVG;
      btn.classList.add('copied');
      setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
    });
  }

  attachPageEdgeBackGesture(leaveSetup, ['.setup-bar', '.setup-content']);

  // App version — baked at build time from package.json, shown on all platforms.
  var verEl = document.getElementById('appVersion');
  if (verEl && typeof __APP_VERSION__ !== 'undefined') {
    verEl.textContent = 'v' + __APP_VERSION__;

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
