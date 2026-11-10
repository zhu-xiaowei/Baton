// Shell checks needed on first paint; keeps Tauri modules off the initial load.
import { harmonyBridge, harmonyCall } from './harmony.js';

export function previewNativeAvailable() {
  if (typeof window === 'undefined') return false;
  return !!(window.isTauri || window.__TAURI_INTERNALS__) || !!harmonyBridge();
}

// ArkWeb and the Tauri webviews cannot open a tab for target=_blank.
export async function openExternalLink(url) {
  if (harmonyBridge()) {
    await harmonyCall('openExternal', { url });
    return;
  }
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  return openUrl(url);
}
