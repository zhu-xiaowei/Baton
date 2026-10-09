import { invoke } from '@tauri-apps/api/core';
import { PreviewTunnel } from './preview-transport.js';
import { parsePreviewTarget } from './preview-link.js';

const status = document.getElementById('status');
const traffic = document.getElementById('traffic');
const debugLog = document.createElement('pre');
debugLog.setAttribute('aria-label', 'Preview transport diagnostics');
debugLog.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font:12px monospace;';
document.body.appendChild(debugLog);
const embeddedKey = __PREVIEW_SMOKE_KEY__;
const embeddedWsUrl = __PREVIEW_SMOKE_WS_URL__;
const embeddedDevice = __PREVIEW_SMOKE_DEVICE__;
let tunnel;
let browserUrl;
let reported = false;

function markFailure(message) {
  status.textContent = message;
  console.error('BATON_REMOTE_PREVIEW_FAIL', message);
}

async function openBrowser(url) {
  if (/Android/i.test(navigator.userAgent)) {
    await invoke('plugin:in-app-browser|open_chrome', {
      payload: { url, toolbarColor: '#161b22' },
    });
  } else if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    const frame = document.createElement('iframe');
    frame.title = 'Remote preview test page';
    frame.style.cssText = 'display:block;width:100%;height:60vh;border:0;background:#fff;';
    frame.src = url;
    document.body.appendChild(frame);
    await new Promise((resolve, reject) => {
      frame.addEventListener('load', resolve, { once: true });
      frame.addEventListener('error', () => reject(new Error('Preview frame did not load')), { once: true });
    });
  } else {
    throw new Error('Mobile runtime required');
  }
}

async function start({ key, wsUrl, device }) {
  if (!key || !wsUrl?.startsWith('wss://')) return markFailure('Missing isolated test connection.');
  const target = parsePreviewTarget('http://localhost:5173/preview-target.html');
  tunnel = new PreviewTunnel({
    device, target, wsUrl, key,
    onDiagnostic: message => { debugLog.textContent += `${message}\n`; },
    onStatus: message => {
      status.textContent = message;
      console.info('BATON_REMOTE_PREVIEW_STAGE', message);
    },
    onTraffic: bytes => {
      traffic.textContent = `Transferred: ${bytes} bytes`;
      if (bytes > 0 && !traffic.dataset.firstByte) {
        traffic.dataset.firstByte = '1';
        console.info('BATON_REMOTE_PREVIEW_FIRST_BYTES');
      }
      if (bytes >= 64 * 1024 && !reported) {
        reported = true;
        console.info('BATON_REMOTE_PREVIEW_PASS', bytes);
      }
    },
  });
  try {
    browserUrl = await tunnel.start();
    status.textContent = `Opening ${browserUrl}`;
    console.info('BATON_REMOTE_PREVIEW_BROWSER_OPENING');
    await openBrowser(browserUrl);
    console.info('BATON_REMOTE_PREVIEW_BROWSER_OPENED');
  } catch (error) {
    markFailure(String(error.message || error));
    await tunnel?.close();
  }
  setTimeout(() => {
    if (!reported) markFailure('Less than 64 KiB reached the in-app browser.');
  }, 30000);
}

document.getElementById('retry').addEventListener('click', () => {
  if (browserUrl) void openBrowser(browserUrl).catch(error => markFailure(error.message));
});

const form = document.getElementById('configForm');
async function startFromClipboard() {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      status.textContent = 'Reading isolated test clipboard.';
      const text = await Promise.race([
        invoke('plugin:clipboard-manager|read_text'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Clipboard read timed out')), 5000)),
      ]);
      const config = JSON.parse(text);
      if (typeof config.apiKey !== 'string' || typeof config.wsUrl !== 'string'
        || typeof config.device !== 'string') throw new Error('Waiting for test config');
      form.hidden = true;
      status.textContent = 'Test config received.';
      void start({ key: config.apiKey, wsUrl: config.wsUrl, device: config.device });
      return;
    } catch (error) {
      status.textContent = `Waiting for isolated test clipboard: ${error.message || error}`;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  markFailure('Isolated test clipboard was not available.');
}
document.getElementById('clipboardStart').addEventListener('click', async () => {
  try {
    const text = await invoke('plugin:clipboard-manager|read_text');
    const config = JSON.parse(text);
    if (typeof config.apiKey !== 'string' || typeof config.wsUrl !== 'string'
      || typeof config.device !== 'string') throw new Error('Invalid test clipboard');
    form.hidden = true;
    void start({ key: config.apiKey, wsUrl: config.wsUrl, device: config.device });
  } catch (error) {
    markFailure(`Test clipboard unavailable: ${error.message || error}`);
  }
});
form.addEventListener('submit', event => {
  event.preventDefault();
  form.hidden = true;
  void start({
    key: form.querySelector('#testKey').value,
    wsUrl: form.querySelector('#testWsUrl').value,
    device: form.querySelector('#testDevice').value,
  });
});
if (new URLSearchParams(location.search).get('auto') === '1') {
  if (embeddedKey && embeddedWsUrl) {
    void start({ key: embeddedKey, wsUrl: embeddedWsUrl, device: embeddedDevice });
  } else {
    form.hidden = false;
    if (new URLSearchParams(location.search).get('clipboard') === '1') {
      void startFromClipboard();
    } else {
      status.textContent = 'Enter the isolated test connection.';
    }
  }
}
window.addEventListener('pagehide', () => { void tunnel?.close(); });
