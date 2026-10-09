import { invoke } from '@tauri-apps/api/core';
import { PreviewTunnel } from './preview-transport.js';
import { parsePreviewTarget } from './preview-link.js';

const status = document.getElementById('status');
const traffic = document.getElementById('traffic');
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
    await invoke('plugin:in-app-browser|open_safari', {
      payload: { url, modalPresentationStyle: 'pageSheet' },
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
    status.textContent = 'Enter the isolated test connection.';
  }
}
window.addEventListener('pagehide', () => { void tunnel?.close(); });
