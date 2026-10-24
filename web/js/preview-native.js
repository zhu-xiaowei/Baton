// Remote preview needs a native loopback proxy, which each shell provides
// differently: Tauri exposes commands and events (src-tauri/src/preview_proxy.rs),
// the HarmonyOS shell an injected bridge (harmony/.../bridge/PreviewBridge.ets).
// This module hides that difference behind the Tauri command/event names, so
// preview-transport.js stays platform-agnostic.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const EVENTS = {
  open: 'preview-socket-open',
  bytes: 'preview-socket-bytes',
  fin: 'preview-socket-fin',
  close: 'preview-socket-close',
};

const COMMANDS = {
  preview_start: 'start',
  preview_stop: 'stop',
  preview_reset: 'reset',
  preview_write: 'write',
  preview_shutdown_write: 'shutdownWrite',
  preview_credit: 'credit',
  preview_close_socket: 'closeSocket',
};

// Fire-and-forget commands: nothing waits for their result.
const SYNC = new Set(['credit', 'closeSocket']);

function shell() {
  return typeof window === 'undefined' ? null : window;
}

function tauriShell() {
  const host = shell();
  return !!host && !!(host.isTauri || host.__TAURI_INTERNALS__);
}

function harmonyPreview() {
  const bridge = shell()?.harmonyPreviewBridge;
  return bridge && typeof bridge.start === 'function' ? bridge : null;
}

function harmonyOpen() {
  const bridge = shell()?.harmonyOpenBridge;
  return bridge && typeof bridge.open === 'function' ? bridge : null;
}

export function previewNativeAvailable() {
  return tauriShell() || !!harmonyPreview();
}

let nextId = 0;
const pending = new Map();
const listeners = new Map();

function installCallback(host) {
  if (host.__onHarmonyPreview) return;
  host.__onHarmonyPreview = message => {
    if (!message) return;
    if (message.event === 'result') {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error));
      else entry.resolve(message.origin);
      return;
    }
    const handlers = listeners.get(EVENTS[message.event]);
    if (!handlers) return;
    for (const handler of Array.from(handlers)) handler({ payload: message });
  };
}

function harmonyInvoke(bridge, host, command, args) {
  const method = COMMANDS[command];
  if (!method || typeof bridge[method] !== 'function') {
    return Promise.reject(new Error(`Preview is unavailable: ${command}`));
  }
  installCallback(host);
  if (SYNC.has(method)) {
    try {
      bridge[method](JSON.stringify(args));
    } catch {
      return Promise.reject(new Error(`Preview is unavailable: ${command}`));
    }
    return Promise.resolve();
  }
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      bridge[method](JSON.stringify({ id, ...args }));
    } catch {
      pending.delete(id);
      reject(new Error(`Preview is unavailable: ${command}`));
    }
  });
}

export function previewInvoke(command, args = {}) {
  const bridge = harmonyPreview();
  if (!bridge) return invoke(command, args);
  return harmonyInvoke(bridge, shell(), command, args);
}

export function previewListen(event, handler) {
  const host = shell();
  if (!harmonyPreview()) return listen(event, handler);
  installCallback(host);
  let handlers = listeners.get(event);
  if (!handlers) {
    handlers = new Set();
    listeners.set(event, handlers);
  }
  handlers.add(handler);
  return Promise.resolve(() => handlers.delete(handler));
}

let nextOpenId = 0;
const openPending = new Map();

function harmonyOpenUrl(bridge, host, url) {
  if (!host.__onHarmonyOpen) {
    host.__onHarmonyOpen = (id, result) => {
      const entry = openPending.get(id);
      if (!entry) return;
      openPending.delete(id);
      if (result?.error) entry.reject(new Error(result.error));
      else entry.resolve();
    };
  }
  const id = ++nextOpenId;
  return new Promise((resolve, reject) => {
    openPending.set(id, { resolve, reject });
    try {
      bridge.open(JSON.stringify({ id, url }));
    } catch {
      openPending.delete(id);
      reject(new Error('Could not open the browser'));
    }
  });
}

// An external link leaves the app: ArkWeb cannot open a tab either, so the
// HarmonyOS shell hands the URL to the system browser like plugin-opener does.
export async function openExternalLink(url) {
  const bridge = harmonyOpen();
  if (bridge) return harmonyOpenUrl(bridge, shell(), url);
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  return openUrl(url);
}

export async function previewOpenExternal(url) {
  if (!harmonyOpen() && /Android/i.test(navigator.userAgent)) {
    return invoke('plugin:in-app-browser|open_chrome', { payload: { url, toolbarColor: '#161b22' } });
  }
  return openExternalLink(url);
}
