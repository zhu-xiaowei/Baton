// Entry for setup.html — install command + Start URL QR
import { state } from './state.js';
import './api.js';
import qrcode from 'qrcode-generator';

(function () {
  // Auth guard: handle ?key= URL param, redirect if missing key
  var urlKey = new URLSearchParams(location.search).get('key');
  if (urlKey) {
    setCredentials(urlKey, location.origin + location.pathname.replace(/\/[^/]*$/, ''));
    history.replaceState(null, '', location.pathname);
  }
  if (!state.KEY) { location.replace('landing.html'); return; }

  // Step 1: Install command — full text, single Copy button.
  // Key is shown in plain text; user is already authenticated to view this page.
  var cmdEl = document.getElementById('installCmdText');
  cmdEl.textContent = 'curl -sL -H "x-api-key: ' + state.KEY + '" "' + state.SERVER + '/api/install" | bash';

  // Step 2: Start URL — same single-URL format the install.sh prints, but
  // backed by the permanent API key (so the QR doesn't expire). Browsers
  // and the native app both accept ?t= and ?key= via the landing page.
  var startUrl = state.SERVER + '/?key=' + encodeURIComponent(state.KEY);
  document.getElementById('qrUrl').textContent = startUrl;

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
