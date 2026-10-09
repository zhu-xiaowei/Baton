import { invoke } from '@tauri-apps/api/core';

const button = document.getElementById('start');
const status = document.getElementById('status');
const frame = document.getElementById('preview');
let expectedOrigin = '';
let timeout;

window.addEventListener('message', event => {
  if (event.source !== frame.contentWindow
    || event.origin !== expectedOrigin
    || event.data?.type !== 'baton-local-preview-probe') return;
  clearTimeout(timeout);
  status.textContent = event.data.ok
    ? 'Passed: the in-app frame loaded the local page, CSS, JavaScript and fetch.'
    : `Local page error: ${event.data.error || 'unknown error'}`;
});

button.addEventListener('click', async () => {
  button.disabled = true;
  status.textContent = 'Starting local page...';
  try {
    const url = await invoke('start_local_preview_probe');
    expectedOrigin = new URL(url).origin;
    frame.hidden = false;
    frame.src = `${url}/`;
    status.textContent = `Loading ${url}/ inside Baton...`;
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      status.textContent = `No result from ${url}/. The in-app frame may have blocked local HTTP.`;
    }, 10000);
  } catch (error) {
    status.textContent = `Could not start the local page: ${error}`;
  } finally {
    button.disabled = false;
  }
});
