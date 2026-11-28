import { state } from '../state.js';
import { loadingSpinner } from './loading.js';
import { RETRY_ICON_SVG } from './icons.js';

// Top-bar status slot: a spinner while reconnecting or while a Session's history is slow (6–12 s),
// a retry button once its load failed.
export function updateWsStatusIndicator() {
  var container = document.getElementById('top-right');
  var indicator = document.getElementById('ws-reconnect-indicator');
  var phase = state.appState.session ? state.wsHistoryPhase : '';
  var kind = phase === 'stale' ? 'retry'
    : (state.wsStatusText === 'reconnecting' || phase === 'slow') ? 'loading' : '';
  if (indicator && indicator.dataset.kind !== kind) {
    indicator.remove();
    indicator = null;
  }
  if (!container || !kind) return;
  if (!indicator) {
    if (kind === 'retry') {
      indicator = document.createElement('button');
      indicator.type = 'button';
      indicator.className = 'project-files-entry';
      indicator.title = 'Retry';
      indicator.setAttribute('aria-label', 'Retry');
      indicator.innerHTML = RETRY_ICON_SVG;
      indicator.onclick = function () { window.retrySessionHistory?.(); };
    } else {
      indicator = document.createElement('span');
      indicator.className = 'ws-reconnect-indicator';
      var label = phase === 'slow' ? 'Loading' : 'Reconnecting';
      indicator.title = label;
      indicator.innerHTML = loadingSpinner({ size: 'small', label: label });
    }
    indicator.id = 'ws-reconnect-indicator';
    indicator.dataset.kind = kind;
  }
  container.insertBefore(indicator, container.firstChild);
}
