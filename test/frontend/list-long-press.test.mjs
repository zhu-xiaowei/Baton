import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const appSource = readFileSync(
  new URL('../../web/js/app.js', import.meta.url),
  'utf8',
);

function gestureHarness() {
  const start = appSource.indexOf('var LONG_PRESS_MS');
  const end = appSource.indexOf('// Unified 3-state', start);
  const handlers = {};
  const scheduled = [];
  const cleared = [];
  const selections = [];
  const context = {
    state: { selectMode: false },
    setTimeout(fn, delay) {
      const timer = { fn, delay };
      scheduled.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      cleared.push(timer);
    },
    enterSelectMode(type, id) {
      selections.push({ type, id });
      context.state.selectMode = true;
    },
    toggleSelected() {},
    updateBreadcrumb() {},
  };
  vm.runInNewContext(appSource.slice(start, end), context);
  const container = {
    addEventListener(name, handler) {
      handlers[name] = handler;
    },
  };
  context.attachLongPress(container, 'session');

  const item = { getAttribute: () => 'session-1' };
  const target = {
    closest(selector) {
      if (selector === '.item[data-id]') return item;
      return null;
    },
  };
  return { context, handlers, scheduled, cleared, selections, target };
}

function pointer(target, overrides = {}) {
  return {
    target,
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    clientX: 20,
    clientY: 20,
    preventDefault() {},
    ...overrides,
  };
}

test('list selection requires a deliberate 800ms touch or mouse long press', () => {
  const touch = gestureHarness();
  touch.handlers.pointerdown(pointer(touch.target));
  assert.equal(touch.scheduled[0].delay, 800);
  touch.scheduled[0].fn();
  assert.deepEqual(touch.selections, [{ type: 'session', id: 'session-1' }]);

  const mouse = gestureHarness();
  mouse.handlers.pointerdown(pointer(mouse.target, { pointerType: 'mouse' }));
  assert.equal(mouse.scheduled[0].delay, 800);
});

test('list long press cancels after small movement or pointer exit', () => {
  const moved = gestureHarness();
  moved.handlers.pointerdown(pointer(moved.target));
  moved.handlers.pointermove(pointer(moved.target, { clientX: 29 }));
  assert.equal(moved.cleared.length, 1);

  const left = gestureHarness();
  left.handlers.pointerdown(pointer(left.target));
  left.handlers.pointerleave(pointer(left.target));
  assert.equal(left.cleared.length, 1);
});
