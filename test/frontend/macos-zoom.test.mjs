import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createZoomController, isNativeMac } from '../../web/js/macos-zoom.js';

function fixture(t, stored = '1') {
  const { window } = new JSDOM('<textarea></textarea><div class="xterm"><textarea></textarea></div>', {
    url: 'https://baton.test/',
  });
  window.localStorage.setItem('baton-macos-zoom', stored);
  const calls = [];
  const controller = createZoomController(window, async (_, { scale }) => { calls.push(scale); });
  t.after(() => { controller.dispose(); window.close(); });
  return { window, calls, controller };
}

test('zoom only activates in the native Mac app', () => {
  const mac = { navigator: { platform: 'MacIntel', maxTouchPoints: 0 }, __TAURI_INTERNALS__: {} };
  assert.equal(isNativeMac(mac), true);
  assert.equal(isNativeMac({ ...mac, __TAURI_INTERNALS__: undefined }), false);
  assert.equal(isNativeMac({ ...mac, navigator: { platform: 'MacIntel', maxTouchPoints: 5 } }), false);
  for (const platform of ['Win32', 'Linux aarch64']) {
    assert.equal(isNativeMac({ ...mac, navigator: { platform } }), false);
  }
});

test('zoom follows the nine fixed levels, stops at the bounds and saves reset', async t => {
  const { window, calls, controller } = fixture(t, '0.75');
  const levels = [0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  for (let i = 0; i < levels.length; i++) controller.changeZoom('in');
  await controller.settled();
  assert.deepEqual(calls, [...levels, 2]);
  const start = calls.length;
  for (let i = 0; i < levels.length; i++) controller.changeZoom('out');
  await controller.settled();
  assert.deepEqual(calls.slice(start), [...levels.slice(0, -1).reverse(), 0.75]);
  await controller.changeZoom('reset');
  assert.equal(calls.at(-1), 1);
  assert.equal(window.localStorage.getItem('baton-macos-zoom'), '1');
});

test('saved zoom restores and shortcuts work in focused inputs without reaching the terminal', async t => {
  const { window, calls, controller } = fixture(t, '1.2');
  const composer = window.document.querySelector('textarea');
  const terminal = window.document.querySelector('.xterm textarea');
  let terminalKeys = 0;
  terminal.addEventListener('keydown', () => terminalKeys++);
  const key = (target, value, options = {}) => {
    target.focus();
    const event = new window.KeyboardEvent('keydown', {
      key: value, metaKey: true, bubbles: true, cancelable: true, ...options,
    });
    target.dispatchEvent(event);
    return event;
  };
  await controller.settled();
  assert.equal(calls[0], 1.25);
  assert.equal(key(composer, '=').defaultPrevented, true);
  assert.equal(key(terminal, '+', { shiftKey: true }).defaultPrevented, true);
  assert.equal(key(terminal, '-').defaultPrevented, true);
  assert.equal(terminalKeys, 0);
  for (const [value, options] of [
    ['c', {}], ['-', { metaKey: false }], ['=', { ctrlKey: true }],
    ['=', { altKey: true }], ['0', { isComposing: true }],
  ]) assert.equal(key(terminal, value, options).defaultPrevented, false);
  assert.equal(terminalKeys, 5);
  assert.equal(key(composer, '0').defaultPrevented, true);
  await controller.settled();
  assert.deepEqual(calls, [1.25, 1.5, 1.75, 1.5, 1]);
  assert.equal(window.localStorage.getItem('baton-macos-zoom'), '1');
});
