import { isNativeMac } from './macos-zoom.js';

let native = null;
let lastTitle = null;

function invoke(command, args) {
  native ??= import('@tauri-apps/api/core');
  return native.then(({ invoke }) => invoke(command, args));
}

// Shortcuts that the macOS menu cannot express reliably (digits, Shift+brackets, Ctrl+Tab).
export function tabShortcut(event) {
  if (event.isComposing || event.defaultPrevented || event.altKey) return null;
  if (event.ctrlKey && !event.metaKey && event.key === 'Tab') {
    return ['macos_tabs_step', { delta: event.shiftKey ? -1 : 1 }];
  }
  if (!event.metaKey || event.ctrlKey) return null;
  if (event.shiftKey && (event.code === 'BracketRight' || event.code === 'BracketLeft')) {
    return ['macos_tabs_step', { delta: event.code === 'BracketRight' ? 1 : -1 }];
  }
  const digit = /^Digit([1-9])$/.exec(event.code);
  if (!event.shiftKey && digit) {
    return ['macos_tabs_select_index', { index: digit[1] === '9' ? -1 : Number(digit[1]) - 1 }];
  }
  return null;
}

export function attachTabShortcuts(win, run) {
  const keydown = event => {
    const shortcut = tabShortcut(event);
    if (!shortcut) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    run(...shortcut);
  };
  win.addEventListener('keydown', keydown, true);
}

// Tab label for the current page; no-op outside the native macOS app.
export function setNativeTabTitle(title, win = window) {
  if (!isNativeMac(win)) return;
  if (title === lastTitle) return;
  lastTitle = title;
  invoke('macos_tabs_set_title', { title }).catch(() => { lastTitle = null; });
}

export function initMacosTabs(win = window) {
  if (!isNativeMac(win)) return;
  attachTabShortcuts(win, (command, args) => invoke(command, args).catch(() => {}));
}
