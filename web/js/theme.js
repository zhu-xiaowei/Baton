import { LIGHT_FILE_ICONS } from './components/file-icon.js';

export function getTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function getThemePreference() {
  return window.batonTheme?.preference?.() || 'dark';
}

export function themeColor(token) {
  return getComputedStyle(document.documentElement).getPropertyValue('--' + token).trim();
}

export function setTheme(mode) {
  window.batonTheme.set(mode);
}

function updateThemeControls() {
  const light = getTheme() === 'light';
  document.querySelectorAll('.d2h-dark-color-scheme, .d2h-light-color-scheme').forEach(element => {
    element.classList.toggle('d2h-dark-color-scheme', !light);
    element.classList.toggle('d2h-light-color-scheme', light);
  });
  document.querySelectorAll('img.file-type-icon').forEach(image => {
    const match = image.getAttribute('src')?.match(/^(.*\/file-icons\/)(?:light\/)?([^/]+)\.svg$/);
    if (match) image.src = match[1] + (light && LIGHT_FILE_ICONS.has(match[2]) ? 'light/' : '') + match[2] + '.svg';
  });
  document.querySelectorAll('[data-theme-option]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.themeOption === getThemePreference()));
  });
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = themeColor('surface-elevated');
}

window.addEventListener('themechange', updateThemeControls);
updateThemeControls();

if (window.__TAURI_INTERNALS__) {
  import('./theme-native.js').then(({ initNativeTheme }) => initNativeTheme()).catch(error => {
    console.warn('Could not synchronize native appearance', error);
  });
}

export function mountThemeSettings() {
  document.querySelectorAll('[data-theme-option]').forEach(button => {
    button.addEventListener('click', () => setTheme(button.dataset.themeOption));
  });
  updateThemeControls();
}
