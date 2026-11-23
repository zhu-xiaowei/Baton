import './theme.js';
// Entry for index.html — first-paint modules only.
// Viewer libs and modules are loaded
// lazily by globals.js -> loadViewerLibs(), triggered after the inline shell renders
// the device list. Diff rendering stays deferred until an Edit is expanded.

import './state.js';
import './api.js';
import { showToast } from './components/toast.js';
import { onDeviceOnline, request } from './v2/direct-transport.js';
import { confirmDialog } from './components/confirm-dialog.js';
import './components/skeleton.js';
import '../css/back-button.css';
import '../css/breadcrumb.css';
import '../css/file-icons.css';
import '../css/loading.css';
import '../css/project-files.css';
import '../css/git-status.css';
import '../css/workspace-header.css';
import '../css/copy.css';
import './globals.js';   // defines window.loadViewerLibs (does NOT download libs yet)
import './app.js';
import './preview-prewarm.js';
import './project/browser.js';
import './scroll-indicator.js';
import './side-panel.js';
import { initMacosZoom } from './macos-zoom.js';
import { initPageZoomShortcuts } from './page-zoom.js';
import { initMacosTabs } from './macos-tabs.js';
import { initSystemBack } from './system-back.js';
import { initMobileNotifications } from './mobile-notifications.js';

initMacosZoom();
initPageZoomShortcuts();
initMacosTabs();
initSystemBack();
void initMobileNotifications();

// Replay any clicks queued by the inline shell before app.js was ready.
if (Array.isArray(window.__navQueue)) {
  var q = window.__navQueue;
  window.__navQueue = null;
  for (var i = 0; i < q.length; i++) { try { q[i](); } catch (e) {} }
}

// Preheat viewer libs after 1.5s — yields IPC/main thread to navigation on Tauri.
if (window.__preheatViewer) setTimeout(window.loadViewerLibs, 1500);

// Settings → Add device returns here (history.go(-2), possibly from the back-forward cache): show home,
// where the new computer appears once its Bridge (started only after approval) is online.
addEventListener('pageshow', (event) => {
  const added = sessionStorage.getItem('baton-added');
  if (!added) return;
  if (event.persisted) { location.reload(); return; }
  const label = sessionStorage.getItem('baton-added-name') || added;
  sessionStorage.removeItem('baton-added');
  sessionStorage.removeItem('baton-added-name');
  window.__connecting = label; // home says so until the computer is online
  const home = () => (window.loadDevices ? window.loadDevices() : setTimeout(home, 100));
  home();
  showToast('Added ' + label);
  // Only while home is still shown: a user who moved on is not pulled back.
  onDeviceOnline((device) => {
    if (device !== added) return;
    window.__connecting = '';
    if (!location.hash.replace(/^#\/?/, '')) window.loadDevices?.();
  });
});

// A device card's Update (index.html): a Bridge update that has waited a day for idle, applied now on confirmation.
async function confirmBridgeUpdate(pill) {
  const days = Math.max(1, Math.floor((Date.now() - Number(pill.dataset.since)) / 864e5));
  const busy = JSON.parse(pill.dataset.busy || '[]');
  const lines = busy.slice(0, 3).map(([title, status]) => `• ${title} — ${status === 'needs_input' ? 'needs input' : 'running'}`);
  if (busy.length > 3) lines.push(`• and ${busy.length - 3} more`);
  if (!busy.length) lines.push('• Background tasks on this computer');
  const detail = [`An update has been waiting for ${days} day${days > 1 ? 's' : ''}. Updating now stops:`, ...lines,
    '• Open terminals on this computer', '', 'Stopped sessions keep their history. Send "continue" to pick up where they left off.'];
  if (!await confirmDialog(`Update Bridge on ${pill.dataset.label}?`, [[false, 'Cancel'], [true, 'Update', true]], false, detail)) return;
  try {
    await request(pill.dataset.update, 'update_now');
    showToast(`Updating ${pill.dataset.label}…`);
    pill.remove();
  } catch (error) {
    showToast(`Update failed: ${error.message}`);
  }
}
const updatePill = (event) => event.target.closest?.('.update-pill[data-update]');
addEventListener('click', (event) => {
  const pill = updatePill(event);
  if (!pill) return;
  event.preventDefault(); // the card is a link
  event.stopPropagation();
  void confirmBridgeUpdate(pill);
}, true);
addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && updatePill(event)) { event.preventDefault(); event.stopPropagation(); void confirmBridgeUpdate(updatePill(event)); }
}, true);
