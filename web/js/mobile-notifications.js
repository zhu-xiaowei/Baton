import { state } from './state.js';
import { createForegroundNotifications, validNotificationTarget } from './notification-runtime.js';

const PREFERENCES = 'baton-notification-preferences';
const INSTALLATION = 'baton-push-installation';
let native, platform, config, poller, initialization, pendingTarget;
let apnsInvoke;
let started = false;
let registrationVersion = 0;
let status = '';

function mobilePlatform() {
  if (!window.__TAURI_INTERNALS__) return '';
  if (/Android/i.test(navigator.userAgent)) return 'android';
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  return '';
}

function preferences() {
  try {
    return { completed: true, needsInput: true, ...JSON.parse(localStorage.getItem(PREFERENCES) || '{}') };
  } catch {
    return { completed: true, needsInput: true };
  }
}

function installationId() {
  let id = localStorage.getItem(INSTALLATION);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(INSTALLATION, id);
  }
  return id;
}

function wantsNotifications() {
  const prefs = preferences();
  return prefs.completed || prefs.needsInput;
}

async function openNotification(event) {
  if (!validNotificationTarget(event)) return;
  pendingTarget = event;
  sessionStorage.setItem('baton-notification-target', JSON.stringify(event));
  if (!config) return;
  if (event.accountId !== config.accountId) {
    pendingTarget = null;
    sessionStorage.removeItem('baton-notification-target');
    window.showStats?.('This notification belongs to another account.');
    return;
  }
  pendingTarget = null;
  if (typeof window.openNotificationSession === 'function') {
    sessionStorage.removeItem('baton-notification-target');
    await window.openNotificationSession(event);
  } else {
    sessionStorage.setItem('baton-notification-target', JSON.stringify(event));
    location.href = 'index.html';
  }
}

function setStatus(value) {
  status = value;
  const label = document.getElementById('notificationStatus');
  if (label) label.textContent = value;
}

async function registerIos() {
  const version = ++registrationVersion;
  const { invoke } = await import('@tauri-apps/api/core');
  const environment = await invoke('ios_push_environment');
  if (!['development', 'production'].includes(environment)) {
    throw new Error('This build has no APNs environment configured.');
  }
  if (!config.ios[environment]) {
    setStatus('iOS push has not been configured on this server.');
    return;
  }
  const { token } = await apnsInvoke('plugin:apns|register');
  if (version !== registrationVersion || !state.KEY || !wantsNotifications()) return;
  await window.apiPost('/api/notifications/devices', {
    installationId: installationId(), token, environment, ...preferences(),
  });
  setStatus('Notifications enabled, including while the app is in the background.');
}

export async function unregisterMobileNotifications() {
  ++registrationVersion;
  poller?.stop();
  if (mobilePlatform() !== 'ios' || !state.KEY || !localStorage.getItem(INSTALLATION)) return;
  // A raw request avoids recursively logging out if the current key has expired.
  const response = await fetch(state.SERVER + '/api/notifications/devices/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': state.KEY },
    body: JSON.stringify({ installationId: installationId() }),
    keepalive: true,
  });
  if (!response.ok && response.status !== 401 && response.status !== 403) {
    throw new Error('Could not disable push notifications. Please try again.');
  }
}

async function applyPreferences(requestPermission = false) {
  if (!native || !config) return;
  if (!wantsNotifications()) {
    await unregisterMobileNotifications();
    setStatus('Notifications disabled.');
    return;
  }
  let granted = await native.isPermissionGranted();
  if (!granted && requestPermission) granted = await native.requestPermission() === 'granted';
  if (!granted) {
    setStatus('Allow notifications in system settings to receive alerts.');
    return;
  }
  if (platform === 'ios') {
    await registerIos();
  } else {
    await native.registerActionTypes([{ id: 'session', actions: [] }]);
    await native.createChannel({
      id: 'session-updates', name: 'Session updates',
      importance: native.Importance.High, visibility: native.Visibility.Private,
      vibration: true,
    });
    if (document.visibilityState === 'visible') poller.start();
    setStatus('Notifications enabled while Baton is in the foreground.');
  }
}

async function initialize() {
  platform = mobilePlatform();
  if (!platform || !state.KEY) return;
  native = await import('@tauri-apps/plugin-notification');
  if (!started) {
    if (platform === 'ios') {
      const { Channel, invoke } = await import('@tauri-apps/api/core');
      apnsInvoke = invoke;
      const drain = async () => {
        const pending = await invoke('plugin:apns|take_pending');
        if (pending.length) await openNotification(pending[pending.length - 1]);
      };
      const onClick = new Channel();
      onClick.onmessage = () => { void drain().catch(error => setStatus(error.message)); };
      await invoke('plugin:apns|listen', { onClick });
      await drain();
    } else {
      await native.onAction(event => {
        if (event.actionId === 'tap') void openNotification(event.notification?.extra);
      });
      poller = createForegroundNotifications({
        fetchEvents: cursor => window.api('/api/notifications/events', cursor ? { cursor } : undefined),
        isVisible: () => document.visibilityState === 'visible' && !!state.KEY && wantsNotifications(),
        enabled: event => preferences()[event.kind === 'completed' ? 'completed' : 'needsInput'],
        show: async event => {
          if (event.accountId !== config.accountId) return;
          await native.sendNotification({
            id: parseInt(event.eventId.slice(0, 7), 16),
            title: event.title, body: event.body, extra: event,
            channelId: 'session-updates', actionTypeId: 'session',
          });
        },
        onError: () => setStatus('Notifications will retry when the connection is restored.'),
      });
    }
    started = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') poller?.stop();
      else void applyPreferences().catch(error => setStatus(error.message));
    });
  }
  config = await window.api('/api/notifications/config');
  if (!pendingTarget) {
    try { pendingTarget = JSON.parse(sessionStorage.getItem('baton-notification-target') || 'null'); } catch {}
    sessionStorage.removeItem('baton-notification-target');
  }
  if (pendingTarget) void openNotification(pendingTarget);
  await applyPreferences(true);
}

export function initMobileNotifications() {
  if (!initialization) {
    initialization = initialize().catch(error => {
      setStatus(error.message);
      initialization = null;
    });
  }
  return initialization;
}

export function mountNotificationSettings() {
  if (!mobilePlatform()) return;
  const section = document.getElementById('notificationSettings');
  if (!section) return;
  section.hidden = false;
  for (const [id, key] of [['notifyCompleted', 'completed'], ['notifyNeedsInput', 'needsInput']]) {
    const input = document.getElementById(id);
    input.checked = preferences()[key];
    input.addEventListener('change', async () => {
      localStorage.setItem(PREFERENCES, JSON.stringify({ ...preferences(), [key]: input.checked }));
      try { await applyPreferences(true); } catch (error) { setStatus(error.message); }
    });
  }
  document.getElementById('retryNotifications').addEventListener('click', async () => {
    try { config = null; await initialize(); } catch (error) { setStatus(error.message); }
  });
  setStatus(status || 'Checking notification permission…');
}

window.unregisterMobileNotifications = unregisterMobileNotifications;
