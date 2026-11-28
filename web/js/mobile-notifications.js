import { state } from './state.js';
import { showToast } from './components/toast.js';
import { dismissInAppNotifications, showInAppNotification } from './components/inapp-notification.js';
import { devices, notifyKey, onPush, openAlert, request } from './v2/direct-transport.js';
import { openSessionInTab, setNativeTabSession } from './macos-tabs.js';

// iOS: APNs. Android: a foreground service polling the event feed (hosted: holding a socket). Both work while
// Baton is in the background; the local push plugin owns notification taps.
const ENABLED = 'baton-notifications-enabled';
const PUSH_DEVICE = 'baton-push-device';
const ASKED = 'baton-notifications-asked';
const TARGET = 'baton-notification-target';
const CONFIG = 'baton-notification-config';
let platform, config, initialization, pendingTarget, permission;
let refreshed = false; // devices() answered this load
let relay = ''; // hosted: Android holds a `role=notify` socket to this URL instead of polling
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
  if (!validTarget(event) && !event?.id && !event?.e) return;
  // A sealed tap waits for devices(): it may be sealed under a rotated K.
  if (!config || (!validTarget(event) && !refreshed)) {
    pendingTarget = event;
    return;
  }
  pendingTarget = null;
  // The phone could not open it before display: open it here.
  if (!validTarget(event)) event = await openAlert(event);
  // The extension could not fetch it before display: the push carried only its ID.
  if (!validTarget(event) && event.id) {
    event = await window.api('/api/notifications/event', { id: event.id }).catch(error => {
      if (String(error.message).startsWith('404')) return null;  // Events live 7 days.
      throw error;
    });
    event = event && await openAlert(event);
  }
  if (!validTarget(event)) return;
  // In-app alerts carry no accountId: they came over this account's own socket.
  if (event.accountId && event.accountId !== config.accountId) {
    showToast('This notification belongs to another account.');
  } else if (typeof window.openNotificationSession === 'function') {
    await window.openNotificationSession(event);
  } else {
    goToIndex(event);
  }
}

function goToIndex(event) {
  sessionStorage.setItem(TARGET, JSON.stringify(event));
  location.href = 'index.html';
}

async function enableIos(prompt) {
  if (!config.ios) return setStatus('iOS push is not configured on this server.');
  // The notification extension reads these to fetch each alert's text.
  const result = await invoke('plugin:push|register', { server: state.SERVER, apiKey: state.KEY, notifyKey: await notifyKey(), prompt });
  if (!result.granted || !enabled() || !state.KEY) return result;
  const device = { token: result.token, environment: result.environment };
  await window.apiPost('/api/notifications/devices', device);
  localStorage.setItem(PUSH_DEVICE, JSON.stringify(device));
  if (!enabled()) return unregisterMobileNotifications();  // Switched off mid-request.
  setStatus('');
  return result;
}

// The switch shows what the device gets: on only if wanted and allowed by the system.
function showSwitch() {
  const input = document.getElementById('notificationsEnabled');
  if (input) input.checked = enabled() && permission?.granted !== false;
}

async function apply(prompt = true) {
  if (enabled()) {
    permission = await (platform === 'ios' ? enableIos(prompt)
      : invoke('plugin:push|start', { server: state.SERVER, apiKey: state.KEY, notifyKey: await notifyKey(), relay, prompt })) || permission;
  } else {
    setStatus('');
  }
  // Just declined in the system prompt: stay off until the switch is turned on again.
  if (prompt && permission?.granted === false && !permission.blocked) localStorage.setItem(ENABLED, '0');
  showSwitch();
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
  if (!state.KEY) return;
  if (!platform) { // a banner tapped on the Settings page
    let target = null;
    try { target = JSON.parse(sessionStorage.getItem(TARGET) || 'null'); } catch {}
    sessionStorage.removeItem(TARGET);
    // A tab the macOS app opened for a tapped notification (macos_tabs open_session): once, not again on reload.
    if (!target && window.__BATON_NOTIFY__ && !sessionStorage.getItem('baton-notify-tab')) {
      target = window.__BATON_NOTIFY__;
      sessionStorage.setItem('baton-notify-tab', '1');
    }
    if (target && window.openNotificationSession) await window.openNotificationSession(target);
    return;
  }
  const { Channel } = await import('@tauri-apps/api/core');
  const drain = async () => {
    const { events } = await invoke('plugin:push|take_pending');
    if (events.length) await openNotification(events[events.length - 1]);
  };
  const onClick = new Channel();
  onClick.onmessage = () => { void drain().catch(error => setStatus(error.message)); };
  await invoke('plugin:push|listen', { onClick });
  // Same server and key as last time (api.js clears it otherwise): a tap opens without waiting.
  try { config = JSON.parse(localStorage.getItem(CONFIG) || 'null'); } catch {}
  void drain().catch(error => setStatus(error.message));
  try { pendingTarget ||= JSON.parse(sessionStorage.getItem(TARGET) || 'null'); } catch {}
  sessionStorage.removeItem(TARGET);
  const body = await devices();
  config = body.notifications;
  refreshed = true;
  relay = body.rpc?.transport === 'relay' ? body.rpc.url : '';
  if (config) localStorage.setItem(CONFIG, JSON.stringify(config));
  else localStorage.removeItem(CONFIG);
  if (!config) return setStatus('Update the Baton server to enable notifications.');
  if (pendingTarget) void openNotification(pendingTarget);
  // On each page load: refreshes the iOS token TTL, restarts the Android service. The first
  // load (also after updating) asks once; later only the switch asks.
  const prompt = !localStorage.getItem(ASKED);
  localStorage.setItem(ASKED, '1');
  await apply(prompt);
  // The phone opens sealed alerts with K's alert key: hand it over again once K arrives.
  window.addEventListener('baton-account-key', () => { void apply(false).catch(() => {}); });
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
  showSwitch();
  input.addEventListener('change', async () => {
    const wanted = input.checked;
    localStorage.setItem(ENABLED, wanted ? '1' : '0');
    try {
      if (wanted) await (config ? apply() : initMobileNotifications().then(() => config && apply()));
      else await unregisterMobileNotifications().then(() => setStatus(''));
      // The system no longer asks: only its Settings can allow Baton, which is checked on return.
      if (wanted && permission?.blocked) {
        const { opened } = await invoke('plugin:push|open_settings', {
          message: 'Notifications are off for Baton. Open Settings to allow them?',
        });
        if (!opened) localStorage.setItem(ENABLED, '0');
      }
    } catch (error) {
      setStatus(error.message);
    }
    showSwitch();
  });
  // Re-check only: an Android request the system denies at once still pauses and resumes the page.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && config) void apply(false).catch(error => setStatus(error.message));
  });
  setStatus(status);
}

// Every App gets each alert first (bridge/notify.mjs). A visible, focused page showing that Session, or showing
// the alert in-app (the Settings switch turns it off), answers: then no device is pushed.
const checked = new Set(); // eventIds: a resent check shows nothing again
onPush(event => {
  if (event.action !== 'notify_check' || checked.has(event.eventId)
    || document.visibilityState !== 'visible' || !document.hasFocus()) return;
  checked.add(event.eventId);
  if (checked.size > 100) checked.delete(checked.values().next().value);
  if (event.rootSessionId !== state.wsRootSessionId
    && !(enabled() && showInAppNotification(event, (alert) => openSessionInTab(alert) || (window.openNotificationSession || goToIndex)(alert)))) return;
  request(event.device, 'notify_seen', { eventId: event.eventId }, { oneWay: true }).catch(() => {});
});

// The device itself never shows an alert for the session it has open in the foreground.
window.setOpenNotificationSession = sessionId => {
  if (sessionId) dismissInAppNotifications(sessionId);
  setNativeTabSession(sessionId);
  if (mobilePlatform()) void invoke('plugin:push|set_open', { sessionId: sessionId || '' }).catch(() => {});
};
window.unregisterMobileNotifications = unregisterMobileNotifications;
