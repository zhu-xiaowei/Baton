import { state } from './state.js';

// iOS: APNs. Android: a foreground service polling the event feed. Both work while
// Baton is in the background; the local push plugin owns notification taps.
const ENABLED = 'baton-notifications-enabled';
const PUSH_DEVICE = 'baton-push-device';
const TARGET = 'baton-notification-target';
let platform, config, initialization, pendingTarget;
let status = '';

function mobilePlatform() {
  if (!window.__TAURI_INTERNALS__) return '';
  if (/Android/i.test(navigator.userAgent)) return 'android';
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  return '';
}

const enabled = () => localStorage.getItem(ENABLED) !== '0';

async function invoke(command, args) {
  const core = await import('@tauri-apps/api/core');
  return core.invoke(command, args);
}

function setStatus(value) {
  status = value;
  const label = document.getElementById('notificationStatus');
  if (label) label.textContent = value;
}

function validTarget(event) {
  return !!event && ['device', 'projectHash', 'sessionId'].every(key =>
    typeof event[key] === 'string' && event[key].length > 0 && event[key].length < 1024);
}

async function openNotification(event) {
  if (!validTarget(event) && !event?.id) return;
  if (!config) {
    pendingTarget = event;
    return;
  }
  pendingTarget = null;
  // The extension could not fetch it before display: the push carried only its ID.
  if (!validTarget(event)) event = await window.api('/api/notifications/event', { id: event.id });
  if (event.accountId !== config.accountId) {
    window.showStats?.('This notification belongs to another account.');
  } else if (typeof window.openNotificationSession === 'function') {
    await window.openNotificationSession(event);
  } else {
    sessionStorage.setItem(TARGET, JSON.stringify(event));
    location.href = 'index.html';
  }
}

async function enableIos() {
  if (!config.ios) return setStatus('iOS push is not configured on this server.');
  // The notification extension reads these to fetch each alert's text.
  const result = await invoke('plugin:push|register', { server: state.SERVER, apiKey: state.KEY });
  if (!result.granted) return setStatus('Allow notifications for Baton in iOS Settings.');
  if (!enabled() || !state.KEY) return;
  const device = { token: result.token, environment: result.environment };
  await window.apiPost('/api/notifications/devices', device);
  localStorage.setItem(PUSH_DEVICE, JSON.stringify(device));
  if (!enabled()) return unregisterMobileNotifications();  // Switched off mid-request.
  setStatus('');
}

async function enableAndroid() {
  const result = await invoke('plugin:push|start', { server: state.SERVER, apiKey: state.KEY });
  setStatus(result.granted ? '' : 'Allow notifications for Baton in system settings.');
}

function apply() {
  if (!enabled()) return setStatus('');
  return platform === 'ios' ? enableIos() : enableAndroid();
}

export async function unregisterMobileNotifications() {
  if (!mobilePlatform()) return;
  await invoke('plugin:push|stop');
  if (mobilePlatform() === 'android') return;
  const device = localStorage.getItem(PUSH_DEVICE);
  if (!device || !state.KEY) return;
  // A raw request: an expired key must not recursively trigger logout.
  const response = await fetch(state.SERVER + '/api/notifications/devices/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': state.KEY },
    body: device,
    keepalive: true,
  });
  if (!response.ok && response.status !== 401 && response.status !== 403) {
    throw new Error('Could not turn off push notifications. Please try again.');
  }
  localStorage.removeItem(PUSH_DEVICE);
}

async function initialize() {
  platform = mobilePlatform();
  if (!platform || !state.KEY) return;
  const { Channel } = await import('@tauri-apps/api/core');
  const drain = async () => {
    const { events } = await invoke('plugin:push|take_pending');
    if (events.length) await openNotification(events[events.length - 1]);
  };
  const onClick = new Channel();
  onClick.onmessage = () => { void drain().catch(error => setStatus(error.message)); };
  await invoke('plugin:push|listen', { onClick });
  await drain();
  try { pendingTarget ||= JSON.parse(sessionStorage.getItem(TARGET) || 'null'); } catch {}
  sessionStorage.removeItem(TARGET);
  // Servers deployed before notifications existed answer 404.
  config = await window.api('/api/notifications/config').catch(error => {
    if (String(error.message).startsWith('404')) return null;
    throw error;
  });
  if (!config) return setStatus('Update the Baton server to enable notifications.');
  if (pendingTarget) void openNotification(pendingTarget);
  await apply();  // Once per launch: refreshes the iOS token TTL, restarts the Android service.
}

export function initMobileNotifications() {
  initialization ||= initialize().catch(error => {
    setStatus(error.message);
    initialization = null;
  });
  return initialization;
}

export function mountNotificationSettings() {
  if (!mobilePlatform()) return;
  const section = document.getElementById('notificationSettings');
  if (!section) return;
  section.hidden = false;
  const input = document.getElementById('notificationsEnabled');
  input.checked = enabled();
  input.addEventListener('change', async () => {
    localStorage.setItem(ENABLED, input.checked ? '1' : '0');
    try {
      if (input.checked) await (config ? apply() : initMobileNotifications());
      else await unregisterMobileNotifications().then(() => setStatus(''));
    } catch (error) {
      setStatus(error.message);
    }
  });
  setStatus(status);
}

// The device itself never shows an alert for the session it has open in the foreground.
window.setOpenNotificationSession = sessionId => {
  if (mobilePlatform()) void invoke('plugin:push|set_open', { sessionId: sessionId || '' }).catch(() => {});
};
window.unregisterMobileNotifications = unregisterMobileNotifications;
