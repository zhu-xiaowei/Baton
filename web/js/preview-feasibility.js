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
  if (event.data.ok) console.info('BATON_LOCAL_PREVIEW_PROBE_PASS');
  else console.error('BATON_LOCAL_PREVIEW_PROBE_FAIL', event.data.error || 'unknown error');
  void invoke('record_local_preview_probe_result', { passed: event.data.ok }).catch(() => {});
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
    console.error('BATON_LOCAL_PREVIEW_PROBE_FAIL', String(error));
  } finally {
    button.disabled = false;
  }
});

if (new URLSearchParams(location.search).get('auto') === '1') button.click();
