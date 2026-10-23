// Shared download button states for the file viewer and the image viewer.
import { loadingSpinner } from './loading.js';

const ICONS = {
  idle: '<path d="M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5"/>',
  done: '<path d="M5 12.5l4.5 4.5L19 7.5" stroke-linecap="round" stroke-linejoin="round"/>',
  failed: '<path d="M7 7l10 10M17 7L7 17" stroke-linecap="round"/>',
};
const RESULT_MS = 1500;
const timers = new WeakMap();

export function setDownloadButtonState(button, state = 'idle') {
  clearTimeout(timers.get(button));
  const busy = state === 'busy';
  button.disabled = busy;
  button.classList.toggle('is-downloading', busy);
  button.classList.toggle('is-failed', state === 'failed');
  button.setAttribute('aria-busy', String(busy));
  button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">'
    + (ICONS[state] || ICONS.idle) + '</svg>'
    + (busy ? '<span class="file-download-spinner">' + loadingSpinner({ size: 'small', label: 'Downloading' }) + '</span>' : '');
  if (state === 'done' || state === 'failed') {
    timers.set(button, setTimeout(() => setDownloadButtonState(button), RESULT_MS));
  }
}
