// Shared download button states for the file viewer and the image viewer.
import { progressRingHtml, setProgressRingPercent } from './progress-ring.js';
import { nativeDownloadsStopOnClose } from '../project/download.js';

const ICONS = {
  idle: '<path d="M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5"/>',
  done: '<path d="M5 12.5l4.5 4.5L19 7.5" stroke-linecap="round" stroke-linejoin="round"/>',
  failed: '<path d="M7 7l10 10M17 7L7 17" stroke-linecap="round"/>',
};
const RESULT_MS = 1500;
const timers = new WeakMap();

// progress: 0..1 fills the pie; null spins the ring while the size is unknown.
export function setDownloadButtonState(button, state = 'idle', progress = null) {
  const busy = state === 'busy';
  // iOS finishes downloading before its share-sheet invoke resolves.
  const complete = busy && progress >= 1 && nativeDownloadsStopOnClose();
  const downloading = busy && !complete;
  // Rebuilding a spinning ring would restart its animation.
  if (!busy || !button.classList.contains('is-downloading') || complete) {
    clearTimeout(timers.get(button));
    button.disabled = busy;
    button.classList.toggle('is-downloading', downloading);
    button.classList.toggle('is-failed', state === 'failed');
    button.setAttribute('aria-busy', String(downloading));
    button.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">'
      + (ICONS[complete ? 'done' : state] || ICONS.idle) + '</svg>'
      + (downloading ? '<span class="file-download-spinner" role="progressbar" aria-label="Downloading"'
        + ' aria-valuemin="0" aria-valuemax="100">' + progressRingHtml() + '</span>' : '');
    if (state === 'done' || state === 'failed') {
      timers.set(button, setTimeout(() => setDownloadButtonState(button), RESULT_MS));
    }
  }
  if (downloading) setDownloadButtonProgress(button, progress);
}

function setDownloadButtonProgress(button, progress) {
  const indicator = button.querySelector('.file-download-spinner');
  if (!indicator) return;
  const known = Number.isFinite(progress);
  const percent = known ? Math.min(99, Math.max(0, Math.round(progress * 100))) : 0;
  indicator.classList.toggle('has-progress', known);
  setProgressRingPercent(indicator, percent);
  if (known) indicator.setAttribute('aria-valuenow', String(percent));
  else indicator.removeAttribute('aria-valuenow');
}
