import { getTheme, getThemePreference, themeColor } from './theme.js';

function currentAppearance() {
  return {
    mode: getTheme(),
    preference: getThemePreference(),
    canvas: themeColor('canvas'),
    surface: themeColor('surface-elevated'),
    strip: themeColor('tab-strip'),
  };
}

export async function initNativeTheme() {
  const harmony = window.harmonyBridge;
  if (harmony?.setTheme) {
    const sync = () => {
      try { harmony.setTheme(JSON.stringify(currentAppearance())); } catch (error) {
        console.warn('Could not apply native appearance', error);
      }
    };
    window.addEventListener('themechange', sync);
    sync();
    return;
  }
  let receiving = false;
  let pending = Promise.resolve();
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');
  const sync = () => {
    if (receiving) return;
    const appearance = currentAppearance();
    pending = pending.catch(() => {}).then(async () => {
      if (window.BatonAndroid?.setTheme) {
        window.BatonAndroid.setTheme(JSON.stringify(appearance));
      } else if (window.webkit?.messageHandlers?.batonAppearance) {
        window.webkit.messageHandlers.batonAppearance.postMessage(appearance);
      } else if (document.documentElement.classList.contains('native-mobile')) {
        return;
      } else {
        await invoke('appearance_set', { appearance });
      }
    }).catch(error => console.warn('Could not apply native appearance', error));
  };
  await listen('baton-theme', event => {
    receiving = true;
    try { window.batonTheme.set(event.payload); } finally { receiving = false; }
  });
  window.addEventListener('themechange', sync);
  window.addEventListener('baton-native-appearance-ready', sync);
  sync();
}
