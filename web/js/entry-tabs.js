import './theme.js';
// Entry for tabs.html — the tab strip webview in the titlebar row (macOS, Windows).
import '../css/tab-strip.css';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { createTabStrip } from './tab-strip.js';
import { attachTabShortcuts, isNativeWindows } from './macos-tabs.js';

if (isNativeWindows(window)) {
  document.getElementById('tab-strip').classList.add('windows');
  document.querySelector('.tab-new').title = 'New Tab (Ctrl+T)';
}
const strip = createTabStrip(document, invoke);
attachTabShortcuts(window, (command, args) => invoke(command, args).catch(() => {}));
getCurrentWebview().listen('macos-tabs', event => strip.render(event.payload))
  .then(() => invoke('macos_tabs_state'))
  .then(state => strip.render(state))
  .catch(error => console.warn('Baton could not load tabs', error));
