import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { initPageZoomShortcuts } from '../../web/js/page-zoom.js';
import { ZOOM_LEVELS } from '../../web/js/macos-zoom.js';

const source = readFileSync(new URL('../../web/public/page-zoom.js', import.meta.url), 'utf8');

function fixture(t, {
  mobile = true, saved, desktopSaved, nativeMac = false, storageBlocked = false, invoke,
  userAgent, platform, maxTouchPoints,
} = {}) {
  const { window } = new JSDOM('', { url: 'https://baton.test', runScripts: 'outside-only' });
  Object.defineProperty(window.navigator, 'userAgent', {
    value: userAgent ?? (mobile ? 'Mozilla/5.0 (iPhone)' : 'Mozilla/5.0 (Macintosh)'),
  });
  if (platform) Object.defineProperty(window.navigator, 'platform', { value: platform, configurable: true });
  if (maxTouchPoints !== undefined) Object.defineProperty(window.navigator, 'maxTouchPoints', { value: maxTouchPoints });
  if (saved) window.localStorage.setItem('baton-text-size', saved);
  if (desktopSaved) window.localStorage.setItem('baton-browser-zoom', desktopSaved);
  if (storageBlocked) Object.defineProperty(window, 'localStorage', { get() { throw new Error('Blocked'); } });
  if (invoke) window.__TAURI_INTERNALS__ = { invoke };
  if (nativeMac) {
    Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel' });
    window.__TAURI_INTERNALS__ = { invoke: async () => {} };
  }
  window.eval(source);
  t.after(() => window.close());
  return window;
}

test('mobile page zoom restores before rendering and persists six levels with a 100% default', t => {
  const window = fixture(t, { saved: 'large' });
  assert.equal(window.document.documentElement.style.getPropertyValue('--page-zoom'), '1.1');
  assert.equal(window.document.documentElement.style.zoom, '1.1');
  assert.equal(window.batonPageZoom.get(), 'large');
  const changes = [];
  window.addEventListener('baton-page-zoom-change', event => changes.push(event.detail.scale));
  for (const level of window.batonPageZoom.levels) window.batonPageZoom.set(level.id);
  assert.deepEqual(changes, [0.9, 1, 1.1, 1.2, 1.3, 1.4]);
  assert.equal(window.localStorage.getItem('baton-text-size'), 'triple-extra-large');
  assert.equal(fixture(t).batonPageZoom.scale(), 1);
});

test('iOS uses native pageZoom without also scaling CSS, and rapid changes keep the latest level', async t => {
  const calls = [];
  const window = fixture(t, { saved: 'large', invoke: async (command, args) => calls.push([command, args.scale]) });
  await window.batonPageZoom.settled();
  assert.deepEqual(calls, [['mobile_set_zoom', 1.1]]);
  assert.equal(window.batonPageZoom.cssScale(), 1);
  assert.equal(window.document.documentElement.style.zoom, '');
  window.batonPageZoom.set('small');
  window.batonPageZoom.set('triple-extra-large');
  await window.batonPageZoom.settled();
  assert.deepEqual(calls.at(-1), ['mobile_set_zoom', 1.4]);
  assert.equal(window.localStorage.getItem('baton-text-size'), 'triple-extra-large');
});

test('older native apps fall back to CSS page zoom when the command is unavailable', async t => {
  const window = fixture(t, { saved: 'large', invoke: async () => { throw new Error('Unknown command'); } });
  window.console.warn = () => {};
  await window.batonPageZoom.settled();
  assert.equal(window.batonPageZoom.cssScale(), 1.1);
  assert.equal(window.document.documentElement.style.zoom, '1.1');
  window.batonPageZoom.set('small');
  assert.equal(window.document.documentElement.style.zoom, '0.9');
});

test('a native app with the old upper limit resets its zoom before using a larger CSS level', async t => {
  const calls = [];
  const window = fixture(t, { saved: 'extra-large', invoke: async (_, { scale }) => {
    calls.push(scale);
    if (scale > 1.25) throw new Error('Old upper limit');
  } });
  window.console.warn = () => {};
  await window.batonPageZoom.settled();
  window.batonPageZoom.set('triple-extra-large');
  await window.batonPageZoom.settled();
  assert.deepEqual(calls, [1.2, 1.4, 1]);
  assert.equal(window.batonPageZoom.cssScale(), 1.4);
});

test('returning through the back cache restores the size selected on the settings page', t => {
  const window = fixture(t);
  window.localStorage.setItem('baton-text-size', 'double-extra-large');
  window.dispatchEvent(new window.PageTransitionEvent('pageshow', { persisted: true }));
  assert.equal(window.batonPageZoom.scale(), 1.3);
});

test('invalid settings and unavailable storage fall back to standard', t => {
  for (const options of [{ saved: 'invalid' }, { storageBlocked: true }]) {
    const window = fixture(t, options);
    assert.equal(window.batonPageZoom.scale(), 1);
    window.batonPageZoom.set('large');
    assert.equal(window.batonPageZoom.scale(), 1.1);
  }
});

test('desktop browser zoom uses nine levels and a separate saved value from mobile', t => {
  const window = fixture(t, { mobile: false, saved: 'triple-extra-large', desktopSaved: '1.75' });
  assert.equal(window.batonPageZoom.enabled, true);
  assert.equal(window.batonPageZoom.levels.length, 9);
  assert.deepEqual(Array.from(window.batonPageZoom.levels, level => level.scale), ZOOM_LEVELS);
  assert.equal(window.batonPageZoom.scale(), 1.75);
  window.batonPageZoom.set('1.25');
  assert.equal(window.localStorage.getItem('baton-browser-zoom'), '1.25');
  assert.equal(window.localStorage.getItem('baton-text-size'), 'triple-extra-large');
});

test('iOS and Android phones and tablets keep six levels in browsers and apps', async t => {
  for (const device of [
    { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', platform: 'iPhone', ios: true },
    { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', platform: 'MacIntel', maxTouchPoints: 5, ios: true },
    { userAgent: 'Mozilla/5.0 (Linux; Android 15; Phone) Mobile', platform: 'Linux armv8l' },
    { userAgent: 'Mozilla/5.0 (Linux; Android 15; Tablet)', platform: 'Linux armv8l' },
  ]) {
    for (const native of [false, true]) {
      const calls = [];
      const window = fixture(t, { ...device, invoke: native ? async command => calls.push(command) : undefined });
      await window.batonPageZoom.settled();
      assert.equal(window.batonPageZoom.enabled, true);
      assert.equal(window.batonPageZoom.levels.length, 6);
      assert.equal(window.batonPageZoom.scale(), 1);
      assert.deepEqual(calls, native && device.ios ? ['mobile_set_zoom'] : []);
    }
  }
});

test('native Mac retains its original controller and storage', t => {
  const window = fixture(t, { mobile: false, nativeMac: true, desktopSaved: '1.75' });
  assert.equal(window.batonPageZoom.enabled, false);
  assert.equal(window.batonPageZoom.scale(), 1);
  assert.equal(window.document.documentElement.style.getPropertyValue('--page-zoom'), '');
  assert.equal(initPageZoomShortcuts(window), null);
});

test('browser shortcuts and the slider share one value even in a focused terminal input', t => {
  const window = fixture(t, { mobile: false });
  const dispose = initPageZoomShortcuts(window);
  t.after(dispose);
  assert.equal(initPageZoomShortcuts(window), dispose);
  const terminal = window.document.createElement('textarea');
  window.document.body.append(terminal);
  let leakedKeys = 0;
  terminal.addEventListener('keydown', () => leakedKeys++);
  const key = (value, options = {}) => {
    const event = new window.KeyboardEvent('keydown', {
      key: value, ctrlKey: true, bubbles: true, cancelable: true, ...options,
    });
    terminal.dispatchEvent(event);
    return event;
  };
  window.batonPageZoom.set('1.25');
  assert.equal(key('=').defaultPrevented, true);
  assert.equal(window.batonPageZoom.scale(), 1.5);
  assert.equal(key('-').defaultPrevented, true);
  assert.equal(window.batonPageZoom.scale(), 1.25);
  assert.equal(key('+', { ctrlKey: false, metaKey: true, shiftKey: true }).defaultPrevented, true);
  assert.equal(window.batonPageZoom.scale(), 1.5);
  assert.equal(key('0').defaultPrevented, true);
  assert.equal(window.batonPageZoom.scale(), 1);
  assert.equal(window.localStorage.getItem('baton-browser-zoom'), '1');
  assert.equal(leakedKeys, 0);
  for (const options of [{ altKey: true }, { metaKey: true }, { isComposing: true }, { ctrlKey: false }]) {
    assert.equal(key('=', options).defaultPrevented, false);
  }
  assert.equal(leakedKeys, 4);
  dispose();
  assert.equal(key('=').defaultPrevented, false);
  assert.equal(window.batonPageZoom.scale(), 1);
});

test('hardware shortcuts on mobile stop at the same six levels as its slider', t => {
  const window = fixture(t);
  t.after(initPageZoomShortcuts(window));
  for (let i = 0; i < 12; i++) {
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: '+', metaKey: true, cancelable: true }));
  }
  assert.equal(window.batonPageZoom.scale(), 1.4);
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: '0', metaKey: true, cancelable: true }));
  assert.equal(window.batonPageZoom.scale(), 1);
});

test('other tabs and clearing preferences immediately update the current page', t => {
  const window = fixture(t);
  window.dispatchEvent(new window.StorageEvent('storage', { key: 'baton-text-size', newValue: 'small', storageArea: window.localStorage }));
  assert.equal(window.batonPageZoom.scale(), 0.9);
  window.dispatchEvent(new window.StorageEvent('storage', { key: null, storageArea: window.localStorage }));
  assert.equal(window.batonPageZoom.scale(), 1);
});
