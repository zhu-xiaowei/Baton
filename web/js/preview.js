import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { state } from './state.js';
import { parsePreviewInput, parsePreviewTarget } from './preview-link.js';
import { PreviewTunnel } from './preview-transport.js';
import '../css/preview.css';

let active = null;
let overlay = null;
let currentUrl = null;
let generation = 0;

function ensureOverlay() {
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'previewOverlay';
  overlay.innerHTML = `
    <section class="preview-panel" role="dialog" aria-label="Remote preview">
      <div class="preview-heading">
        <strong>Remote preview</strong>
        <button class="preview-close" type="button" aria-label="Close preview">×</button>
      </div>
      <div class="preview-device"></div>
      <form class="preview-form">
        <label for="previewAddress">Remote localhost port or URL</label>
        <div class="preview-input-row">
          <input id="previewAddress" name="address" placeholder="5173 or http://localhost:5173/" autocomplete="off" required>
          <button type="submit">Open</button>
        </div>
      </form>
      <p class="preview-status" role="status">Enter a port or open a localhost link in this session.</p>
      <code class="preview-local-url" hidden></code>
      <div class="preview-actions">
        <button class="preview-reopen" type="button" disabled>Open browser again</button>
        <button class="preview-stop" type="button">Stop preview</button>
      </div>
    </section>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.preview-close').addEventListener('click', () => { void closePreview(); });
  overlay.querySelector('.preview-stop').addEventListener('click', () => { void stopPreview(); });
  overlay.querySelector('.preview-reopen').addEventListener('click', () => {
    if (currentUrl) void openPreviewBrowser(currentUrl).catch(error => setStatus(error.message));
  });
  overlay.querySelector('.preview-form').addEventListener('submit', event => {
    event.preventDefault();
    const target = parsePreviewInput(overlay.querySelector('#previewAddress').value);
    if (!target) return setStatus('Enter an HTTP localhost URL or a port from 1 to 65535.');
    void startPreview(target, overlay.dataset.device);
  });
  return overlay;
}

function setStatus(text) {
  if (overlay) overlay.querySelector('.preview-status').textContent = text;
}

async function wsUrl() {
  if (!state.KEY || !state.SERVER) throw new Error('Sign in before opening a preview.');
  const cached = state.WS_URL || localStorage.getItem('_wsurl');
  if (cached?.startsWith('wss://')) return cached;
  const response = await fetch(`${state.SERVER.replace(/\/$/, '')}/api/bridge/config`, {
    headers: { 'x-api-key': state.KEY }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Preview configuration failed: HTTP ${response.status}`);
  const config = await response.json();
  if (!config.wsUrl?.startsWith('wss://')) throw new Error('Server did not provide a WSS endpoint.');
  return config.wsUrl;
}

async function openPreviewBrowser(url) {
  if (/Android/i.test(navigator.userAgent)) {
    await invoke('plugin:in-app-browser|open_chrome', {
      payload: { url, toolbarColor: '#161b22' },
    });
  } else if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    await invoke('plugin:in-app-browser|open_safari', {
      payload: {
        url, modalPresentationStyle: 'pageSheet',
        preferredBarTintColor: '#161b22ff',
        preferredControlTintColor: '#58a6ffff',
      },
    });
  } else {
    await openUrl(url);
  }
}

async function stopPreview(invalidate = true) {
  if (invalidate) generation++;
  currentUrl = null;
  overlay?.querySelector('.preview-reopen')?.setAttribute('disabled', '');
  overlay?.querySelector('.preview-local-url')?.setAttribute('hidden', '');
  const previous = active;
  active = null;
  await previous?.close();
  setStatus('Preview stopped.');
}

async function closePreview() {
  await stopPreview();
  overlay?.remove();
  overlay = null;
}

async function startPreview(target, device) {
  if (!device) return setStatus('Select a device first.');
  const current = ++generation;
  const view = ensureOverlay();
  view.dataset.device = device;
  view.querySelector('.preview-device').textContent = `Device: ${device}`;
  view.querySelector('#previewAddress').value = target.displayUrl;
  await stopPreview(false);
  if (current !== generation) return;
  setStatus(`Connecting to ${device}:${target.port}...`);
  let tunnel;
  try {
    const endpoint = await wsUrl();
    if (current !== generation) return;
    tunnel = new PreviewTunnel({
      device, target, wsUrl: endpoint, key: state.KEY, onStatus: setStatus,
    });
    active = tunnel;
    const url = await tunnel.start();
    if (active !== tunnel || current !== generation) {
      await tunnel.close();
      return;
    }
    currentUrl = url;
    const link = view.querySelector('.preview-local-url');
    link.textContent = url;
    link.hidden = false;
    view.querySelector('.preview-reopen').disabled = false;
    await openPreviewBrowser(url);
  } catch (error) {
    if (current !== generation) return;
    setStatus(`Preview failed: ${error.message || error}`);
    if (active === tunnel) {
      await tunnel.close();
      active = null;
    }
  }
}

export function openPreviewLink(value, device) {
  const target = parsePreviewTarget(value);
  if (!target) return false;
  ensureOverlay();
  void startPreview(target, device);
  return true;
}

export function showPreviewInput(device) {
  const view = ensureOverlay();
  view.dataset.device = device || '';
  view.querySelector('.preview-device').textContent = device ? `Device: ${device}` : 'Select a device first.';
  view.querySelector('#previewAddress').focus();
}

window.addEventListener('pagehide', () => { void active?.close(); });
