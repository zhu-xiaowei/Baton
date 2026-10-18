import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { attachTerminalKeybar } from '../../web/js/terminal-keybar.js';

const css = readFileSync(new URL('../../web/css/terminal.css', import.meta.url), 'utf8');

function setup(context) {
  const dom = new JSDOM('<!doctype html><html class="native-mobile"><style>' + css + '</style><body>'
    + '<section class="project-terminal-page"><main class="project-terminal-screen"><div class="xterm-screen"></div>'
    + '<textarea></textarea><div class="xterm-scrollbar"></div></main></section></body></html>', { pretendToBeVisual: true });
  const { window } = dom;
  const { document } = window;
  const page = document.querySelector('section');
  const screen = document.querySelector('main');
  const surface = screen.querySelector('.xterm-screen');
  screen.getBoundingClientRect = () => ({ left: 0, top: 40, right: 360, bottom: 600 });
  let now = 0;
  let nextTimer = 0;
  let enabled = true;
  let starts = 0;
  const timers = new Map();
  window.setTimeout = (callback, delay) => {
    const timer = ++nextTimer;
    timers.set(timer, { callback, at: now + delay });
    return timer;
  };
  window.clearTimeout = timer => timers.delete(timer);
  const advance = milliseconds => {
    const end = now + milliseconds;
    while (true) {
      const next = [...timers].sort((left, right) => left[1].at - right[1].at)[0];
      if (!next || next[1].at > end) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
    }
    now = end;
  };
  const sent = [];
  const errors = [];
  const pasted = [];
  const terminal = {
    textarea: screen.querySelector('textarea'),
    modes: { applicationCursorKeysMode: false },
    scrollToBottom() {},
    attachCustomKeyEventHandler(callback) { this.keyHandler = callback; },
    paste(text) { pasted.push(text); },
  };
  const controls = attachTerminalKeybar({ page, screen, terminal, send: data => sent.push(data),
    canInput: () => enabled, showError: text => errors.push(text), onJoystickStart: () => starts++ });
  const bar = page.querySelector('.project-terminal-keybar');
  const overlay = page.querySelector('.project-terminal-joystick');
  const button = key => bar.querySelector(`[data-key="${key}"]`);
  const touch = (type, { x = 150, y = 200, count = type === 'touchend' ? 0 : 1, target = surface } = {}) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    const point = { identifier: 1, clientX: x, clientY: y };
    Object.defineProperties(event, {
      touches: { value: Array.from({ length: count }, (_, index) => ({ ...point, identifier: index + 1 })) },
      changedTouches: { value: [point] },
    });
    target.dispatchEvent(event);
    return event;
  };
  context.after(() => { controls.dispose(); window.close(); });
  return { window, document, page, surface, terminal, controls, bar, overlay, button, touch, advance, sent, pasted, errors,
    starts: () => starts, timers, setEnabled(value) { enabled = value; controls.sync(); } };
}

test('the seven-key row appears only above the native mobile keyboard without stealing input focus', context => {
  const { window, document, page, terminal, bar, button } = setup(context);
  assert.deepEqual([...bar.children].map(child => child.textContent), ['Esc', 'Tab', 'Ctrl', 'Shift', 'Alt', 'Paste', 'Enter']);
  assert.equal(window.getComputedStyle(bar).display, 'none');
  page.classList.add('keyboard-open');
  assert.equal(window.getComputedStyle(bar).display, 'grid');
  assert.equal(window.getComputedStyle(page).paddingBottom, '0px');
  terminal.textarea.focus();
  const press = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  button('ctrl').dispatchEvent(press);
  button('ctrl').click();
  assert.equal(press.defaultPrevented, true);
  assert.equal(document.activeElement, terminal.textarea);
  document.documentElement.classList.remove('native-mobile');
  assert.equal(window.getComputedStyle(bar).display, 'none');
});

test('one-shot modifiers encode soft and hardware keys without modifying composition or paste', context => {
  const { window, terminal, controls, button, sent } = setup(context);
  button('Escape').click();
  button('Tab').click();
  button('ctrl').click();
  assert.equal(controls.handleData('c'), true);
  assert.equal(button('ctrl').getAttribute('aria-pressed'), 'false');
  button('shift').click();
  button('Tab').click();
  button('shift').click();
  assert.equal(controls.handleData('1'), true);
  button('alt').click();
  const key = new window.KeyboardEvent('keydown', { key: 'b', cancelable: true });
  assert.equal(terminal.keyHandler(key), false);
  assert.equal(key.defaultPrevented, true);
  assert.deepEqual(sent, ['\x1b', '\t', '\x03', '\x1b[Z', '!', '\x1bb']);
  button('ctrl').click();
  terminal.textarea.dispatchEvent(new window.Event('compositionstart', { bubbles: true }));
  assert.equal(controls.handleData('中文'), false);
  button('ctrl').click();
  terminal.textarea.dispatchEvent(new window.Event('paste', { bubbles: true }));
  assert.equal(controls.handleData('c'), false);
  button('ctrl').click();
  assert.equal(controls.handleData('multiple characters'), false);
  assert.equal(button('ctrl').getAttribute('aria-pressed'), 'false');
});

test('paste uses the terminal paste path and discards clipboard results after a session reset', async context => {
  const { window, controls, button, pasted, errors } = setup(context);
  const originalWindow = globalThis.window;
  globalThis.window = window;
  context.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  let resolveRead;
  window.__TAURI_INTERNALS__ = { invoke(command) {
    assert.equal(command, 'plugin:clipboard-manager|read_text');
    return new Promise(resolve => { resolveRead = resolve; });
  } };
  button('ctrl').click();
  button('Paste').click();
  assert.equal(button('ctrl').getAttribute('aria-pressed'), 'false');
  assert.equal(button('Paste').disabled, true);
  resolveRead('echo hello\n');
  await new Promise(setImmediate);
  assert.deepEqual(pasted, ['echo hello\n']);
  button('Paste').click();
  controls.reset();
  resolveRead('do not send to the next session');
  await new Promise(setImmediate);
  assert.equal(pasted.length, 1);
  window.__TAURI_INTERNALS__.invoke = async () => { throw new Error('Permission denied'); };
  button('Paste').click();
  await new Promise(setImmediate);
  assert.equal(errors.length, 1);
});

test('short taps and ordinary drags do not activate or intercept the joystick', context => {
  const { touch, advance, overlay, sent, starts } = setup(context);
  assert.equal(touch('touchstart').defaultPrevented, false);
  advance(200);
  assert.equal(touch('touchend').defaultPrevented, false);
  advance(500);
  assert.equal(overlay.hidden, true);
  touch('touchstart');
  assert.equal(touch('touchmove', { y: 220 }).defaultPrevented, false);
  advance(500);
  touch('touchend');
  assert.equal(starts(), 0);
  assert.deepEqual(sent, []);
});

test('the joystick keeps drag control, stays after release, supports held buttons and dismisses without toggling the keyboard', context => {
  const { window, document, page, terminal, button, surface, touch, advance, overlay, sent, timers, starts } = setup(context);
  const pointer = (type, target = surface) => {
    const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 150, clientY: 200 });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    target.dispatchEvent(event);
    return event;
  };
  terminal.textarea.focus();
  button('ctrl').click();
  let propagatedMoves = 0;
  let propagatedEnds = 0;
  document.addEventListener('touchmove', () => propagatedMoves++);
  document.addEventListener('touchend', () => propagatedEnds++);
  touch('touchstart', { x: 350, y: 590 });
  advance(450);
  assert.equal(overlay.hidden, false);
  assert.equal(overlay.style.left, '272px');
  assert.equal(overlay.style.top, '512px');
  assert.equal(starts(), 1);
  touch('touchmove', { x: 322, y: 562 });
  touch('touchmove', { x: 272, y: 512 });
  assert.equal(sent.length, 0);
  assert.equal(touch('touchmove', { x: 272, y: 482 }).defaultPrevented, true);
  assert.deepEqual(sent, ['\x1b[1;5A']);
  advance(299);
  assert.equal(sent.length, 1);
  advance(1);
  assert.equal(sent.length, 2);
  touch('touchmove', { x: 272, y: 452 });
  advance(140);
  assert.equal(sent.length, 4);
  touch('touchmove', { x: 272, y: 512 });
  advance(500);
  assert.equal(sent.length, 4);
  touch('touchmove', { x: 332, y: 512 });
  assert.equal(sent.at(-1), '\x1b[1;5C');
  advance(140);
  assert.equal(sent.length, 7);
  const release = pointer('pointerup');
  assert.equal(release.defaultPrevented, true);
  assert.equal(touch('touchend').defaultPrevented, true);
  assert.equal(overlay.hidden, false);
  assert.equal(timers.size, 0);
  assert.equal(button('ctrl').getAttribute('aria-pressed'), 'false');
  assert.equal(propagatedMoves, 0);
  assert.equal(propagatedEnds, 1);
  assert.equal(document.activeElement, terminal.textarea);
  const count = sent.length;
  advance(1000);
  assert.equal(sent.length, count);

  touch('touchstart');
  assert.equal(touch('touchmove', { y: 220 }).defaultPrevented, false);
  touch('touchend');
  assert.equal(overlay.hidden, false);
  assert.equal(propagatedMoves, 1);
  assert.equal(sent.length, count);

  terminal.modes.applicationCursorKeysMode = true;
  const up = overlay.querySelector('[data-direction="ArrowUp"]');
  const down = overlay.querySelector('[data-direction="ArrowDown"]');
  assert.equal(pointer('pointerdown', up).defaultPrevented, true);
  touch('touchstart', { target: up });
  assert.equal(sent.at(-1), '\x1bOA');
  advance(299);
  assert.equal(sent.length, count + 1);
  advance(1);
  assert.equal(sent.length, count + 2);
  advance(70);
  assert.equal(sent.length, count + 3);
  pointer('pointerup', up);
  touch('touchend', { target: up });
  assert.equal(pointer('click', up).defaultPrevented, true);
  advance(500);
  assert.equal(sent.length, count + 3);
  assert.equal(overlay.hidden, false);
  assert.equal(timers.size, 0);
  pointer('pointerdown', down);
  pointer('pointerup', down);
  pointer('click', down);
  assert.equal(sent.at(-1), '\x1bOB');
  assert.equal(sent.length, count + 4);
  assert.equal(document.activeElement, terminal.textarea);

  let keyboardTaps = 0;
  page.addEventListener('pointerdown', () => keyboardTaps++);
  pointer('pointerdown');
  touch('touchstart');
  pointer('pointerup');
  assert.equal(touch('touchend').defaultPrevented, true);
  assert.equal(pointer('click').defaultPrevented, true);
  assert.equal(overlay.hidden, true);
  assert.equal(keyboardTaps, 0);
  assert.equal(document.activeElement, terminal.textarea);
  pointer('pointerdown');
  touch('touchstart');
  pointer('pointerup');
  assert.equal(touch('touchend').defaultPrevented, false);
  assert.equal(keyboardTaps, 1);
});

test('cancel, multiple touches, disconnect, background and disposal stop held keys', context => {
  const { window, controls, touch, advance, overlay, timers, setEnabled } = setup(context);
  for (const cancel of [() => touch('touchcancel'), () => touch('touchstart', { count: 2 }),
    () => setEnabled(false), () => window.dispatchEvent(new window.Event('blur')), () => controls.dispose()]) {
    setEnabled(true);
    touch('touchstart');
    advance(450);
    touch('touchmove', { y: 150 });
    assert.equal(overlay.hidden, false);
    cancel();
    assert.equal(overlay.hidden, true);
    assert.equal(timers.size, 0);
  }
});
