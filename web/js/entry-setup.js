// Entry for setup.html — install command + QR
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

  // Step 1: Render install command
  var cmdEl = document.getElementById('installCmdText');
  cmdEl.textContent = 'curl -sL -H "x-api-key: ' + state.KEY + '" "' + state.SERVER + '/api/install" | bash';

  // Step 2: QR Code
  var viewerUrl = state.SERVER + '/landing.html?key=' + encodeURIComponent(state.KEY);
  document.getElementById('qrUrl').textContent = viewerUrl;

  var qr = qrcode(0, 'M');
  qr.addData(viewerUrl);
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

  // Helpers used inside this scope
  function copyText(btn, text) {
    navigator.clipboard.writeText(text).then(function () {
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
    });
  }
  function copyCmd(btn) { copyText(btn, document.getElementById('installCmdText').textContent); }
  function copyUrl(btn) { copyText(btn, document.getElementById('qrUrl').textContent); }

  // Expose handlers used by inline onclick attributes
  window.copyCmd = copyCmd;
  window.copyUrl = copyUrl;
})();
