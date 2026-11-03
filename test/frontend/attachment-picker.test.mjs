import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { state } from '../../web/js/state.js';
import { openAttachmentPicker } from '../../web/js/components/attachment-picker.js';

function fixture(t, { mobile = true, keyboard = true } = {}) {
  const dom = new JSDOM('<!doctype html><div id="input-bar">'
    + '<input type="file" id="img-picker"><button class="img-btn">+</button>'
    + '<textarea id="msg-input"></textarea></div>', { pretendToBeVisual: true });
  const { window } = dom;
  Object.assign(globalThis, { window, document: window.document });
  window.document.documentElement.classList.toggle('native-mobile', mobile);
  state.appState = { device: 'device', project: { hash: 'project' }, session: '__new__' };
  const viewport = new window.EventTarget();
  viewport.height = keyboard ? 420 : 844;
  Object.defineProperty(window, 'innerHeight', { value: 844 });
  Object.defineProperty(window, 'visualViewport', { value: viewport });
  const bar = document.getElementById('input-bar');
  bar.classList.toggle('kb-up', keyboard);
  bar.getClientRects = () => [{}];
  const input = document.getElementById('msg-input');
  const button = document.querySelector('.img-btn');
  const openings = [];
  document.getElementById('img-picker').click = () => openings.push(viewport.height);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => dom.window.close());
  const resize = height => {
    viewport.height = height;
    bar.classList.toggle('kb-up', height < 633);
    viewport.dispatchEvent(new window.Event('resize'));
  };
  return { window, bar, input, button, openings, resize };
}

for (const [name, options] of [
  ['desktop', { mobile: false }],
  ['mobile with the keyboard closed', { keyboard: false }],
]) {
  test(name + ' opens the picker synchronously', t => {
    const { openings } = fixture(t, options);
    openAttachmentPicker();
    assert.equal(openings.length, 1);
  });
}

test('picker waits for keyboard dismissal and the final viewport position', async t => {
  const { input, openings, resize } = fixture(t);
  input.focus();
  const pending = openAttachmentPicker();
  assert.notEqual(document.activeElement, input);
  assert.deepEqual(openings, []);
  assert.equal(openAttachmentPicker(), pending, 'repeated taps share one pending open');

  resize(600);
  t.mock.timers.tick(100);
  resize(700);
  t.mock.timers.tick(100);
  resize(844);
  t.mock.timers.tick(119);
  assert.deepEqual(openings, [], 'do not use an intermediate keyboard animation frame');
  t.mock.timers.tick(1);
  await pending;
  assert.deepEqual(openings, [844]);
  t.mock.timers.tick(1000);
  assert.deepEqual(openings, [844], 'deadline and resize callbacks are cleaned up');
});

test('missing viewport events do not leave the attachment button stuck', async t => {
  const { openings } = fixture(t);
  const pending = openAttachmentPicker();
  t.mock.timers.tick(899);
  assert.deepEqual(openings, []);
  t.mock.timers.tick(1);
  await pending;
  assert.equal(openings.length, 1);
});

for (const reason of ['navigation', 'disabled', 'read-only', 'removed']) {
  test('pending picker is cancelled after ' + reason, async t => {
    const { button, bar, openings, resize } = fixture(t);
    const pending = openAttachmentPicker();
    if (reason === 'navigation') state.appState.session = 'another-session';
    if (reason === 'disabled') button.disabled = true;
    if (reason === 'read-only') bar.inert = true;
    if (reason === 'removed') bar.remove();
    resize(844);
    t.mock.timers.tick(120);
    await pending;
    assert.deepEqual(openings, []);
  });
}
