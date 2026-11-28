import { mountThemeSettings } from './theme.js';
// Entry for setup.html — install command + Start URL QR
import { defaultServer, state } from './state.js';
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
import { recoveryKey, removeDevice, viaComputer } from './v2/pairing.js';
import { openAddDevice } from './v2/add-device.js';
import { cachedOnlineDevices, connect, devices, relayFrameBytes, request } from './v2/direct-transport.js';
import { toPhrase } from './v2/recovery.js';
import { confirmDialog } from './components/confirm-dialog.js';
import { COPY_ICON } from './copy.js';
import { showCenteredModal, hideCenteredModal } from './components/modal-viewport.js';
import { routeExternalLinks } from './native-shell.js';

initMacosTabs();
initPageZoomShortcuts();
routeExternalLinks();
setNativeTabTitle('Settings');

(function () {
  // Auth guard: handle ?key= URL param, redirect if missing key
  var urlKey = new URLSearchParams(location.search).get('key');
  if (urlKey) {
    setCredentials(urlKey, defaultServer());
    history.replaceState(null, '', location.pathname);
  }
  if (!state.KEY) { location.replace('landing.html'); return; }
  mountTextSizeSettings();
  mountNotificationSettings();
  void initMobileNotifications();
  // The App socket, for in-app alerts (mobile-notifications.js), again when shown. On AWS a Bridge sends them only
  // to Apps it has heard from: a one-way hello (no handler, ignored) makes this connection known.
  var join = function () {
    connect();
    devices().then(function () { if (!relayFrameBytes()) cachedOnlineDevices().forEach(function (d) { request(d, 'hello', {}, { oneWay: true }).catch(function () {}); }); }).catch(function () {});
  };
  join();
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') join(); });
  mountThemeSettings();

  function fromIndex() {
    var referrer = document.referrer ? new URL(document.referrer) : null;
    return referrer && referrer.origin === location.origin && /\/(?:index\.html)?$/.test(referrer.pathname);
  }

  function leaveSetup() {
    if (!(window.isTauri || window.__TAURI_INTERNALS__)) {
      location.href = 'index.html';
      return;
    }
    sessionStorage.setItem('baton-returning-home', '1');
    if (fromIndex() && history.length > 1) history.back();
    else location.href = 'index.html';
  }

  // The scan icon shows where Add device can scan: the phone apps (as on the sign-in page).
  var nativeApp = !location.origin.startsWith('http') || location.origin.includes('tauri.localhost');
  if ((nativeApp && ('ontouchstart' in window || navigator.maxTouchPoints > 0)) || window.harmonyBridge) {
    document.querySelector('.add-device .scan-icon').removeAttribute('hidden'); // an SVG has no .hidden property
  }

  // After adding, home is shown: going back past this page when home opened it.
  function addDevice() {
    var backToHome = fromIndex() && history.length > 2;
    openAddDevice({
      underlaySelectors: ['.setup-bar', '.setup-content'],
      onAdded: function () { if (backToHome) history.go(-2); else location.replace('index.html'); },
    });
  }
  document.querySelector('.add-device').addEventListener('click', function (event) { event.preventDefault(); addDevice(); });
  if (location.hash === '#add') { history.replaceState(null, '', location.pathname + location.search); addDevice(); }

  // Only an account created by pairing has a recovery phrase, deletion and Apps to remove (not a paired App
  // of a self-hosted, API-key account).
  var paired = state.KEY.indexOf('bt_') === 0;
  var listing = null;
  var installBase = '';  // the hosted service's short install address (agentbaton.app), if it has one
  // The first frame uses what /devices said last time (or the hosted service's known values); it only corrects.
  var accountStore = 'baton-settings-account';  // cleared with the account (api.js)
  var account = state.SERVER === 'https://api.agentbaton.app' ? { hosted: true, install: 'https://agentbaton.app' } : null;
  try { account = JSON.parse(localStorage.getItem(accountStore)) || account; } catch (_) {}
  if (paired) devices().then(function (body) {
    listing = body;
    account = { hosted: !!body.hosted, install: body.install || '' };
    try { localStorage.setItem(accountStore, JSON.stringify(account)); } catch (_) {}
    applyAccount();
  }, function () {});

  // Text content only (the device's own name); never inside an attribute.
  function esc(text) { var el = document.createElement('span'); el.textContent = text; return el.innerHTML; }

  function renderApps() {
    var apps = (listing && listing.apps || []).filter(function (app) { return app.kind === 'app'; });
    document.getElementById('appsRemoveOthers').hidden = apps.length < 3;
    document.getElementById('appsList').innerHTML = apps.map(function (app) {
      var seen = app.lastSeen ? new Date(app.lastSeen * 1000).toLocaleString() : '';
      return '<div class="agent-thread-row"><span class="agent-thread-copy"><span class="agent-thread-title"><strong>' + esc(app.deviceName)
        + '</strong></span><span class="agent-thread-meta"><small>' + esc(seen) + '</small></span></span>'
        + (app.id === listing.self ? '<span class="app-self">This device</span>'
          : '<button class="app-remove" type="button" data-id="' + app.id + '">Remove</button>')
        + '</div>';
    }).join('');
  }

  // The Subagents sheet's open/close (app.js), which this page does not load.
  var sheet = document.getElementById('appsSheet');
  window.openAppsSheet = function () {
    renderApps();
    sheet.style.display = 'flex';
    void sheet.offsetWidth;
    sheet.classList.add('open');
    devices().then(function (body) { listing = body; renderApps(); }, function () {});
  };
  window.closeAppsSheet = function () {
    sheet.classList.remove('open');
    setTimeout(function () { if (!sheet.classList.contains('open')) sheet.style.display = 'none'; }, 320);
  };

  function failed(title, error) { return confirmDialog(title, [[true, 'OK', true]], true, error.message); }

  // A lost phone or browser: its token stops and the account key is replaced, as for a computer.
  document.getElementById('appsList').addEventListener('click', async function (event) {
    var button = event.target.closest('.app-remove');
    // The name comes from the listing, never from markup: a device picks its own name.
    var app = button && listing.apps.find(function (candidate) { return candidate.id === button.dataset.id; });
    if (!app || !await confirmDialog('Remove ' + app.deviceName + '?', [[false, 'Cancel'], [true, 'Remove', true]], false,
      'It is signed out at once and cannot reach your computers again; to use it again, add it with a new code.')) return;
    button.disabled = true;
    try {
      listing = await removeDevice('/api/tokens/revoke', { id: button.dataset.id });
      renderApps();
    } catch (e) {
      button.disabled = false;
      await failed('Could not remove it', e);
    }
  });

  window.removeOtherApps = async function (button) {
    var others = listing.apps.filter(function (app) { return app.kind === 'app' && app.id !== listing.self; });
    if (!others.length || !await confirmDialog('Remove ' + others.length + ' other phones and browsers?', [[false, 'Cancel'], [true, 'Remove', true]], false,
      'They are signed out at once; your computers stay. To use one again, add it with a new code.')) return;
    button.disabled = true;
    try {
      listing = await removeDevice('/api/tokens/revoke', { ids: others.map(function (app) { return app.id; }).join(',') });
      renderApps();
    } catch (e) {
      await failed('Could not remove them', e);
    } finally { button.disabled = false; }
  };

  // Opened by Show phrase; Show opens it in place (R sealed under K, from /devices) and the dialog stays.
  var phraseDialog = document.getElementById('phraseDialog');
  var phraseNote = document.getElementById('phraseNote').textContent;
  var phraseRun = 0;  // a load that finishes after close or reopen is dropped
  phraseDialog.addEventListener('keydown', function (event) { if (event.key === 'Escape') window.closePhrase(); });
  window.showRecoveryPhrase = function () {
    phraseRun++;
    document.getElementById('phraseShow').disabled = false;
    document.getElementById('phraseNote').textContent = phraseNote;
    phraseDialog.querySelector('.phrase').hidden = true;
    phraseDialog.querySelector('.cancel').style.display = '';
    document.getElementById('phraseShow').textContent = 'Show';
    showCenteredModal(phraseDialog);
    phraseDialog.querySelector('.modal-box').focus();
  };
  window.closePhrase = function () {
    phraseRun++;
    document.getElementById('phraseWords').textContent = '';
    hideCenteredModal(phraseDialog);
  };
  window.loadPhrase = async function (button) {
    if (!phraseDialog.querySelector('.phrase').hidden) return window.closePhrase();
    button.innerHTML = '<span class="spinner"></span>';
    button.disabled = true;
    var run = phraseRun;
    try {
      var r = await recoveryKey();
      if (!r) throw new Error('Turn on one of your computers, then try again: it makes the phrase.');
      var phrase = await toPhrase(r);
      if (run !== phraseRun) return;
      // Shown as it is pasted: words separated by spaces, no numbers.
      document.getElementById('phraseWords').textContent = phrase;
      phraseDialog.querySelector('.phrase .code-btn').innerHTML = COPY_ICON;
      phraseDialog.querySelector('.phrase').hidden = false;
      document.getElementById('phraseNote').textContent = 'To get the account back on a new phone or browser, open Baton and paste these words into the sign-in field (where a Start URL goes).';
      phraseDialog.querySelector('.cancel').style.display = 'none';
      button.textContent = 'Done';
    } catch (e) {
      if (run !== phraseRun) return;
      button.textContent = 'Show';
      await failed('Could not show the phrase', e);
    } finally { if (run === phraseRun) button.disabled = false; }
  };
  window.copyPhrase = function (button) {
    copyText(button, document.getElementById('phraseWords').textContent);
  };

  window.deleteAccount = async function () {
    var answer = confirmDialog('Delete account?', [[false, 'Cancel'], [true, 'Delete', true]], false,
      'This cannot be undone. Every phone, browser and computer leaves the account, each Bridge uninstalls itself, '
      + 'and the recovery phrase stops working. Files and sessions on your computers are kept.');
    // Armed after 5 s, like removing a computer on home.
    var button = Array.from(document.querySelectorAll('.modal-overlay .modal-btn.confirm')).pop();
    var left = 5;
    button.classList.add('danger');
    button.disabled = true;
    button.textContent = 'Delete (5)';
    var timer = setInterval(function () {
      button.disabled = --left > 0;
      button.textContent = left > 0 ? 'Delete (' + left + ')' : 'Delete';
      if (!left) clearInterval(timer);
    }, 1000);
    if (!await answer) return;
    try {
      await apiPost('/api/account/delete');
      logout();
    } catch (e) {
      await failed('Could not delete the account', e);
    }
  };

  mountBackButton(document.getElementById('setupBackButton'), leaveSetup);
  initSystemBack({ navigate: () => { leaveSetup(); return true; } });

  // One 15-minute code serves the three tabs, requested only when one is shown: with the API key a start
  // token (the key never appears in them), for a paired App a one-use invite an online computer seals K into.
  var platform = /Win/.test(navigator.platform) ? 'windows' : 'unix';
  var tokenRequest = null;

  function startToken() {
    tokenRequest = tokenRequest || (paired ? viaComputer('pair_invite') : apiPost('/api/auth/start-token')).then(function (result) {
      setTimeout(resetConnect, result.expiresIn * 1000);
      return paired ? result.link : state.SERVER + '/?t=' + result.token;
    }, function (error) { tokenRequest = null; throw error; });
    return tokenRequest;
  }

  // A paired account installs with the public command; an API-key one with its start token.
  function connectText(panel, startUrl) {
    if (panel === 'url') return startUrl;
    if (installBase) return platform === 'windows' ? 'irm ' + installBase + '/install.ps1 | iex' : 'curl -fsSL ' + installBase + '/install | bash';
    var url = paired ? state.SERVER + '/install' : startUrl.replace('/?t=', '/auth/install?t=');
    return platform === 'windows' ? "irm '" + url + (paired ? '?' : '&') + "platform=windows' | iex" : 'curl -sL "' + url + '" | bash';
  }

  var values = {};  // each tab's full text; a code is shown only as its first and last characters

  function resetConnect() {
    tokenRequest = null;
    document.querySelectorAll('.connect .code-block').forEach(function (block) {
      if (paired && block.dataset.panel === 'install') return;  // public, never expires
      delete values[block.dataset.panel];
      block.classList.add('masked');
      block.querySelector('.text').textContent = '••••••••••••••••••••••••••••••••';
    });
    document.querySelector('.connect .qr-frame').classList.remove('ready');
    if (!document.querySelector('[data-panel="qr"]').hidden) reveal().catch(function () {});
  }

  // One code fills all three tabs, so switching tabs never loads again.
  function reveal() {
    return startToken().then(function (startUrl) {
      var code = /[#?&][ct]=([^&]+)/.exec(startUrl)[1];
      document.querySelectorAll('.connect .code-block').forEach(function (block) {
        var text = values[block.dataset.panel] = connectText(block.dataset.panel, startUrl);
        block.querySelector('.text').textContent = text.split(code).join(code.slice(0, 4) + '***' + code.slice(-4));
        block.classList.remove('masked');
      });
      drawQr(startUrl);
    });
  }

  // Copies at once, requesting the code first if needed (the clipboard write starts within the click).
  window.copyConnect = function (button) {
    var panel = button.parentElement.dataset.panel;
    if (values[panel]) return copyText(button, values[panel]);
    button.innerHTML = '<span class="spinner"></span>';
    button.disabled = true;
    copyText(button, reveal().then(function () { return values[panel]; }))
      .catch(function () { button.innerHTML = COPY_ICON; })
      .finally(function () { button.disabled = false; });
  };

  window.selectConnectTab = function (tab) {
    document.querySelectorAll('.connect-tabs .platform-option').forEach(function (button) {
      button.classList.toggle('active', button.dataset.tab === tab);
    });
    document.querySelectorAll('.connect [data-panel]').forEach(function (panel) { panel.hidden = panel.dataset.panel !== tab; });
    if (tab === 'qr' && !document.querySelector('.connect .qr-frame.ready')) reveal().catch(function () {});
  };

  // A paired account's install command is public (no credential): shown as it is.
  function applyAccount() {
    installBase = account && account.install || '';
    var install = document.querySelector('[data-panel="install"]');
    var text = connectText('install', '');
    values.install = text;
    if (install.querySelector('.text').textContent !== text) install.querySelector('.text').textContent = text;
    install.classList.remove('masked');
    if (!account) return;
    document.querySelectorAll('.hosted-only').forEach(function (row) { row.hidden = !account.hosted; });
    // A paired App of a self-hosted stack has no install command it could show (the public one is hosted only).
    var tab = document.querySelector('[data-tab="install"]');
    tab.hidden = !account.hosted;
    if (tab.hidden && tab.classList.contains('active')) window.selectConnectTab('url');
  }
  if (paired) applyAccount();

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

  // `text` may be a promise: WebKit only accepts a later value through a ClipboardItem made during the click.
  function copyText(btn, text) {
    var later = function () { return Promise.resolve(text).then(function (value) { return navigator.clipboard.writeText(value); }); };
    var write = typeof text === 'string' || !window.ClipboardItem ? later()
      : navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then(function (value) { return new Blob([value], { type: 'text/plain' }); }) })])
        .catch(later);
    return write.then(function () {
      btn.innerHTML = CHECK_ICON_SVG;
      btn.classList.add('copied');
      setTimeout(function () { btn.innerHTML = COPY_ICON; btn.classList.remove('copied'); }, 2000);
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
