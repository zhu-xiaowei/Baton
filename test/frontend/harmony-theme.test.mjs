import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const themeInit = readFileSync(new URL('../../web/public/theme-init.js', import.meta.url), 'utf8');

function runThemeInit(window) {
  const root = { dataset: {}, style: {} };
  window.document = { documentElement: root };
  window.localStorage = { getItem: () => null, setItem() {} };
  window.matchMedia = () => ({ matches: true, addEventListener() {} });
  window.addEventListener = () => {};
  window.dispatchEvent = () => {};
  window.CustomEvent = class {};
  vm.runInNewContext(themeInit, { window, document: window.document, localStorage: window.localStorage, CustomEvent: window.CustomEvent });
  return root;
}

test('the first frame uses the theme the HarmonyOS shell saved', () => {
  const root = runThemeInit({ harmonyBridge: { getTheme: () => 'light' } });
  assert.equal(root.dataset.theme, 'light');
  assert.equal(root.dataset.themePreference, 'light');
});

test('theme changes reach harmonyBridge.setTheme without loading Tauri', async () => {
  const sent = [];
  const listeners = {};
  globalThis.window = {
    harmonyBridge: { setTheme: json => sent.push(JSON.parse(json)) },
    batonTheme: { preference: () => 'system' },
    addEventListener: (name, handler) => { listeners[name] = handler; },
  };
  globalThis.document = {
    documentElement: { dataset: { theme: 'light' } },
    querySelectorAll: () => [],
    querySelector: () => ({}),
  };
  globalThis.getComputedStyle = () => ({ getPropertyValue: name => ({ '--canvas': ' #ffffff' })[name] || '#000000' });
  try {
    const { initNativeTheme } = await import('../../web/js/theme-native.js');
    await initNativeTheme();
    assert.deepEqual(sent[0].mode, 'light');
    assert.equal(sent[0].preference, 'system');
    assert.equal(sent[0].canvas, '#ffffff');
    listeners.themechange();
    assert.equal(sent.length, 2);
  } finally {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.getComputedStyle;
  }
});
