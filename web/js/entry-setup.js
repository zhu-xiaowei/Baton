// Entry for setup.html — install command + QR + connected devices
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

  // Step 3: Connected devices
  (async function () {
    var el = document.getElementById('deviceList');
    try {
      var data = await api('/api/bridge/devices');
      if (!data.devices || data.devices.length === 0) {
        el.innerHTML = '<div class="empty">No devices connected yet. Run the install command above to get started.</div>';
        return;
      }
      el.innerHTML = data.devices.map(function (d) {
        var ago = timeAgo(d.lastActive);
        var dotClass = d.online ? 'online' : 'offline';
        var rc = d.runningCount || 0, ic = d.idleCount || 0;
        return '<div class="device-item">'
          + '<div class="device-top">'
          + '<div class="device-dot ' + dotClass + '"></div>'
          + '<div class="device-name">' + esc(d.deviceName) + '</div>'
          + '<div class="device-time">' + ago + '</div>'
          + '</div>'
          + '<div class="device-meta"><span>' + osName(d.os) + ' &middot; ' + d.projectCount + ' projects</span><span>' + rc + ' running &middot; ' + ic + ' idle</span></div>'
          + '</div>';
      }).join('');
    } catch (e) {
      el.innerHTML = '<div class="empty">Error loading devices: ' + e.message + '</div>';
    }
  })();

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
  function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function osName(os) { return { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }[os] || os || 'unknown'; }
  function timeAgo(iso) {
    var diff = Date.now() - new Date(iso).getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return Math.floor(diff / 86400000) + 'd ago';
  }

  // Expose handlers used by inline onclick attributes
  window.copyCmd = copyCmd;
  window.copyUrl = copyUrl;
})();
