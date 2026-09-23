import { state } from '../state.js';
import { loadingSpinner } from './loading.js';

export function updateWsStatusIndicator() {
  var container = document.getElementById('top-right');
  var indicator = document.getElementById('ws-reconnect-indicator');
  var reconnecting = state.wsStatusText === 'reconnecting'
    || state.wsRealtimeStatusText === 'reconnecting';
  if (!container || !reconnecting) {
    indicator?.remove();
    return;
  }
  if (!indicator) {
    indicator = document.createElement('span');
    indicator.id = 'ws-reconnect-indicator';
    indicator.className = 'ws-reconnect-indicator';
    indicator.title = 'Reconnecting';
    indicator.innerHTML = loadingSpinner({ size: 'small', label: 'Reconnecting' });
  }
  container.insertBefore(indicator, container.querySelector('.git-status-entry') || container.firstChild);
}
