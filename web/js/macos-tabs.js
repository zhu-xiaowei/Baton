import { isNativeMac } from './macos-zoom.js';
import { state } from './state.js';

let native = null;
let lastTitle = null;

export function isNativeWindows(win) {
  return !!win.__TAURI_INTERNALS__ && /^Win/.test(win.navigator.platform);
}

const hasNativeTabs = win => isNativeMac(win) || isNativeWindows(win);

function invoke(command, args) {
  native ??= import('@tauri-apps/api/core');
  return native.then(({ invoke }) => invoke(command, args));
}

// Shortcuts that the macOS menu cannot express reliably (digits, Shift+brackets, Ctrl+Tab).
// Windows has no menu: Ctrl replaces Cmd and Ctrl+T/W/N are handled here, except in the terminal (readline
// keys, also Ctrl+digits); non-Latin layouts match the key position.
export function tabShortcut(event, windows = false) {
  if (event.isComposing || event.defaultPrevented || event.altKey) return null;
  if (event.ctrlKey && !event.metaKey && event.key === 'Tab') {
    return ['macos_tabs_step', { delta: event.shiftKey ? -1 : 1 }];
  }
  if (windows ? !event.ctrlKey || event.metaKey : !event.metaKey || event.ctrlKey) return null;
  const terminal = windows && event.target?.closest?.('.xterm');
  const letter = windows && !event.shiftKey && !terminal
    && (/^[a-z]$/i.test(event.key) ? event.key.toLowerCase() : /^Key([A-Z])$/.exec(event.code)?.[1].toLowerCase());
  if (letter === 't') return ['macos_tabs_new'];
  if (letter === 'w') return ['macos_tabs_close'];
  if (letter === 'n') return ['macos_tabs_new_window'];
  if (!windows && event.shiftKey && (event.code === 'BracketRight' || event.code === 'BracketLeft')) {
    return ['macos_tabs_step', { delta: event.code === 'BracketRight' ? 1 : -1 }];
  }
  const digit = /^Digit([1-9])$/.exec(event.code);
  if (!event.shiftKey && digit && !terminal) {
    return ['macos_tabs_select_index', { index: digit[1] === '9' ? -1 : Number(digit[1]) - 1 }];
  }
  return null;
}

export function attachTabShortcuts(win, run) {
  const windows = isNativeWindows(win);
  const keydown = event => {
    const shortcut = tabShortcut(event, windows);
    if (!shortcut) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    run(...shortcut);
  };
  win.addEventListener('keydown', keydown, true);
}

// Tab label for the current page; no-op outside the native macOS and Windows apps.
export function setNativeTabTitle(title, win = window) {
  if (!hasNativeTabs(win)) return;
  if (title === lastTitle) return;
  lastTitle = title;
  invoke('macos_tabs_set_title', { title }).catch(() => { lastTitle = null; });
}

// The root Session this tab shows, so a tapped notification can switch to it.
export function setNativeTabSession(sessionId, win = window) {
  if (hasNativeTabs(win)) invoke('macos_tabs_set_session', { session: sessionId || '' }).catch(() => {});
}

// A tapped notification: the leftmost tab showing its Session, else a new tab opening it. False outside the tabbed apps.
export function openSessionInTab(target, win = window) {
  if (!hasNativeTabs(win)) return false;
  invoke('macos_tabs_open_session', { session: target.rootSessionId || target.sessionId, target }).catch(() => {});
  return true;
}

export function initMacosTabs(win = window) {
  if (!hasNativeTabs(win)) return;
  invoke('macos_tabs_set_session', { session: '' }).catch(() => {}); // a new page shows no Session until it opens one
  import('@tauri-apps/api/webview').then(({ getCurrentWebview }) => getCurrentWebview().listen('macos-tabs-notify', ({ payload }) => {
    if (payload.sessionId !== state.wsSessionId) win.openNotificationSession?.(payload);
  })).catch(() => {});
  attachTabShortcuts(win, (command, args) => invoke(command, args).catch(() => {}));
}
