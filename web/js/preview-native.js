// Remote preview's loopback proxy, addressed by the Tauri command/event names
// (src-tauri/src/preview_proxy.rs) and mapped onto the HarmonyOS bridge.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { harmonyBridge, harmonyCall, harmonySend, onHarmonyEvent } from './harmony.js';
import { openExternalLink } from './native-shell.js';

const EVENTS = {
  open: 'preview-socket-open',
  bytes: 'preview-socket-bytes',
  fin: 'preview-socket-fin',
  close: 'preview-socket-close',
};

const COMMANDS = {
  preview_start: 'previewStart',
  preview_stop: 'previewStop',
  preview_reset: 'previewReset',
  preview_write: 'previewWrite',
  preview_shutdown_write: 'previewShutdownWrite',
  preview_credit: 'previewCredit',
  preview_close_socket: 'previewCloseSocket',
};

const FIRE_AND_FORGET = new Set(['preview_credit', 'preview_close_socket']);

export function previewInvoke(command, args = {}) {
  if (!harmonyBridge()) return invoke(command, args);
  const method = COMMANDS[command];
  if (!method) return Promise.reject(new Error(`Preview is unavailable: ${command}`));
  if (!FIRE_AND_FORGET.has(command)) return harmonyCall(method, args);
  try {
    harmonySend(method, args);
    return Promise.resolve();
  } catch {
    return Promise.reject(new Error(`Preview is unavailable: ${command}`));
  }
}

export function previewListen(event, handler) {
  if (!harmonyBridge()) return listen(event, handler);
  return Promise.resolve(onHarmonyEvent(message => {
    if (EVENTS[message.event] === event) handler({ payload: message });
  }));
}

export async function previewOpenExternal(url) {
  if (!harmonyBridge() && /Android/i.test(navigator.userAgent)) {
    return invoke('plugin:in-app-browser|open_chrome', { payload: { url, toolbarColor: getComputedStyle(document.documentElement).getPropertyValue('--surface').trim() || '#161b22' } });
  }
  return openExternalLink(url);
}
