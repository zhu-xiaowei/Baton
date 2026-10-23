import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { tabShortcut } from '../../web/js/macos-tabs.js';
import { createTabStrip } from '../../web/js/tab-strip.js';

const stripHtml = readFileSync(new URL('../../web/tabs.html', import.meta.url), 'utf8');

test('tab shortcuts map digits, brackets and Ctrl+Tab without stealing other keys', () => {
  const key = (code, extra = {}) => ({ code, key: '', metaKey: true, ...extra });
  assert.deepEqual(tabShortcut(key('Digit1')), ['macos_tabs_select_index', { index: 0 }]);
  assert.deepEqual(tabShortcut(key('Digit9')), ['macos_tabs_select_index', { index: -1 }]);
  assert.deepEqual(tabShortcut(key('BracketRight', { shiftKey: true })), ['macos_tabs_step', { delta: 1 }]);
  assert.deepEqual(tabShortcut(key('BracketLeft', { shiftKey: true })), ['macos_tabs_step', { delta: -1 }]);
  assert.deepEqual(tabShortcut({ key: 'Tab', ctrlKey: true, shiftKey: true }), ['macos_tabs_step', { delta: -1 }]);
  for (const other of [key('Digit0'), key('KeyT'), key('Digit1', { altKey: true }), key('Digit1', { isComposing: true }),
    { code: 'Digit1', key: '1' }, { key: 'Tab' }]) {
    assert.equal(tabShortcut(other), null);
  }
});

test('the strip keeps tab nodes, follows order and selection, and forwards actions', async () => {
  const { window } = new JSDOM(stripHtml, { url: 'https://baton.test/tabs.html' });
  const calls = [];
  const strip = createTabStrip(window.document, async (command, args) => { calls.push([command, args]); });
  const tabs = () => [...window.document.querySelectorAll('.tab')];
  strip.render({ tabs: [{ id: 'main', title: 'Baton' }], selected: 'main', fullscreen: false });
  const first = tabs()[0];
  strip.render({
    tabs: [{ id: 'tab-1', title: 'Fix login' }, { id: 'main', title: 'agentpeek' }],
    selected: 'tab-1', fullscreen: true,
  });
  assert.deepEqual(tabs().map(tab => tab.textContent), ['Fix login', 'agentpeek']);
  assert.equal(tabs()[1], first);
  assert.deepEqual(tabs().map(tab => tab.classList.contains('active')), [true, false]);
  assert.equal(window.document.getElementById('tab-strip').classList.contains('fullscreen'), true);

  tabs()[1].dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
  tabs()[1].querySelector('.tab-close').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  tabs()[0].dispatchEvent(new window.MouseEvent('auxclick', { bubbles: true, button: 1 }));
  window.document.querySelector('.tab-new').click();
  assert.deepEqual(calls, [
    ['macos_tabs_select', { id: 'main' }],
    ['macos_tabs_close', { id: 'main' }],
    ['macos_tabs_close', { id: 'tab-1' }],
    ['macos_tabs_new', undefined],
  ]);
  window.close();
});
