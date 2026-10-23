// Entry for tabs.html — the macOS titlebar tab strip webview.
import '../css/tab-strip.css';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { createTabStrip } from './tab-strip.js';
import { attachTabShortcuts } from './macos-tabs.js';

const strip = createTabStrip(document, invoke);
attachTabShortcuts(window, (command, args) => invoke(command, args).catch(() => {}));
getCurrentWebview().listen('macos-tabs', event => strip.render(event.payload))
  .then(() => invoke('macos_tabs_state'))
  .then(state => strip.render(state))
  .catch(error => console.warn('Baton could not load tabs', error));
