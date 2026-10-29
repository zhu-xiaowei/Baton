import { state } from './state.js';
import { createForegroundNotifications, validNotificationTarget } from './notification-runtime.js';

// iOS: APNs, including in the background. Android: foreground-only local alerts.
const ENABLED = 'baton-notifications-enabled';
const PUSH_DEVICE = 'baton-push-device';
const TARGET = 'baton-notification-target';
let platform, config, android, poller, initialization, pendingTarget;
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

async function openNotification(event) {
  if (!validNotificationTarget(event)) return;
  if (!config) {
    pendingTarget = event;
    return;
  }
  pendingTarget = null;
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
  const result = await invoke('plugin:apns|register');
  if (!result.granted) return setStatus('Allow notifications for Baton in iOS Settings.');
  if (!enabled() || !state.KEY) return;
  const device = { token: result.token, environment: result.environment };
  await window.apiPost('/api/notifications/devices', device);
  localStorage.setItem(PUSH_DEVICE, JSON.stringify(device));
  if (!enabled()) return unregisterMobileNotifications();  // Switched off mid-request.
  setStatus('');
}

async function enableAndroid() {
  android ||= await import('@tauri-apps/plugin-notification');
  if (!poller) {
    await android.onAction(event => {
      if (event.actionId === 'tap') void openNotification(event.notification?.extra);
    });
    await android.createChannel({
      id: 'session-updates', name: 'Session updates',
      importance: android.Importance.High, visibility: android.Visibility.Private, vibration: true,
    });
    poller = createForegroundNotifications({
      fetchEvents: cursor => window.api('/api/notifications/events', cursor ? { cursor } : undefined),
      isVisible: () => document.visibilityState === 'visible' && !!state.KEY && enabled(),
      show: event => event.accountId === config.accountId && android.sendNotification({
        id: parseInt(event.eventId.slice(0, 7), 16),
        title: event.title, body: event.body, extra: event, channelId: 'session-updates',
      }),
    });
  }
  let granted = await android.isPermissionGranted();
  if (!granted) granted = await android.requestPermission() === 'granted';
  if (!granted) return setStatus('Allow notifications for Baton in system settings.');
  poller.start();
  setStatus('');
}

function apply() {
  if (!enabled()) return setStatus('');
  return platform === 'ios' ? enableIos() : enableAndroid();
}

export async function unregisterMobileNotifications() {
  poller?.stop();
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
  if (platform === 'ios') {
    const { Channel } = await import('@tauri-apps/api/core');
    const drain = async () => {
      const pending = await invoke('plugin:apns|take_pending');
      if (pending.length) await openNotification(pending[pending.length - 1]);
    };
    const onClick = new Channel();
    onClick.onmessage = () => { void drain().catch(error => setStatus(error.message)); };
    await invoke('plugin:apns|listen', { onClick });
    await drain();
  }
  try { pendingTarget ||= JSON.parse(sessionStorage.getItem(TARGET) || 'null'); } catch {}
  sessionStorage.removeItem(TARGET);
  // Servers deployed before notifications existed answer 404.
  config = await window.api('/api/notifications/config').catch(error => {
    if (String(error.message).startsWith('404')) return null;
    throw error;
  });
  if (!config) return setStatus('Update the Baton server to enable notifications.');
  if (pendingTarget) void openNotification(pendingTarget);
  if (platform === 'android') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') poller?.stop();
      else void apply()?.catch(error => setStatus(error.message));
    });
  }
  await apply();  // iOS re-registers once per launch, refreshing the server-side TTL.
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

window.unregisterMobileNotifications = unregisterMobileNotifications;
