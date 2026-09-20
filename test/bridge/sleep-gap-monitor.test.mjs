import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { SleepGapMonitor } from '../../bridge/sleep-gap-monitor.mjs';
import { RealtimeSender } from '../../bridge/realtime-direct.mjs';

function harness() {
  let now = 100_000;
  let callback = null;
  let starts = 0;
  const gaps = [];
  const monitor = new SleepGapMonitor({
    onResume: (gap) => gaps.push(gap),
    wallNow: () => now,
    setInterval: (handler, delay) => {
      assert.equal(delay, 10_000);
      starts += 1;
      callback = handler;
      return 0;
    },
    clearInterval: () => { callback = null; },
  });
  monitor.start();
  return {
    monitor, gaps,
    get starts() { return starts; },
    elapse(milliseconds, check = true) {
      now += milliseconds;
      if (check) callback?.();
    },
  };
}

test('starts one ten-second timer and does not mistake normal intervals for sleep', () => {
  const state = harness();
  state.monitor.start();
  for (let check = 0; check < 360; check += 1) state.elapse(10_000);
  assert.equal(state.starts, 1);
  assert.deepEqual(state.gaps, []);
});

test('allows five seconds of scheduling slack, then reports a long gap once', () => {
  const state = harness();
  state.elapse(15_000);
  assert.deepEqual(state.gaps, []);
  state.elapse(15_001);
  state.elapse(10_000);
  assert.deepEqual(state.gaps, [15_001]);
});

test('detects a sleep gap at the next check without depending on the OS monotonic clock', () => {
  const state = harness();
  state.elapse(60_000, false);
  assert.deepEqual(state.gaps, []);
  state.elapse(10_000);
  assert.deepEqual(state.gaps, [70_000]);
});

test('wall-clock rollback does not reconnect or prevent later sleep detection', () => {
  const state = harness();
  state.elapse(-60_000);
  state.elapse(10_000);
  assert.deepEqual(state.gaps, []);
  state.elapse(60_000);
  assert.deepEqual(state.gaps, [60_000]);
});

test('stop cancels the monitor, including zero-valued timer handles and late callbacks', () => {
  const state = harness();
  state.monitor.stop();
  state.monitor.stop();
  state.elapse(60_000);
  state.monitor.tick();
  assert.equal(state.monitor.timer, null);
  assert.deepEqual(state.gaps, []);
});

test('restart establishes a new baseline instead of treating downtime as sleep', () => {
  const state = harness();
  state.monitor.stop();
  state.elapse(60_000);
  state.monitor.start();
  state.elapse(10_000);
  assert.equal(state.starts, 2);
  assert.deepEqual(state.gaps, []);
});

test('monitor does not keep an otherwise finished Bridge process alive', () => {
  const monitor = new SleepGapMonitor();
  monitor.start();
  try { assert.equal(monitor.timer.hasRef(), false); } finally { monitor.stop(); }
});

function connectionHarness() {
  const source = fs.readFileSync(new URL('../../bridge/ws.mjs', import.meta.url), 'utf8');
  const stateStart = source.indexOf('let _ws = null;');
  const stateEnd = source.indexOf('// onExit only fires', stateStart);
  const connectStart = source.indexOf('function connect() {');
  const connectEnd = source.indexOf('async function handleMessage', connectStart);
  assert.ok(stateStart >= 0 && stateEnd > stateStart && connectStart > stateEnd && connectEnd > connectStart);
  const sockets = [];
  const timers = new Map();
  let timerId = 1;
  class FakeSocket extends EventEmitter {
    static OPEN = 1;
    constructor() {
      super();
      this.readyState = 0;
      sockets.push(this);
    }
    terminate() { this.readyState = 3; this.emit('error', new Error('terminated during handshake')); }
    send() {}
  }
  const context = vm.createContext({
    WebSocket: FakeSocket, SleepGapMonitor, RealtimeSender,
    console: { log() {}, error() {} }, process: { platform: process.platform }, BRIDGE_VERSION: 'test',
    _terminalRemote: null, _sharedTerminals: null,
    setTimeout: (callback, delay) => { const id = timerId++; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (callback, delay) => { const id = timerId++; timers.set(id, { callback, delay }); return id; },
    clearInterval: (id) => timers.delete(id),
  });
  vm.runInContext(source.slice(stateStart, stateEnd) + source.slice(connectStart, connectEnd), context);
  vm.runInContext("_config = { wsUrl: 'ws://localhost', apiKey: 'test', deviceName: 'test' };", context);
  return { sockets, timers, run: (code) => vm.runInContext(code, context) };
}

test('wake bypasses existing five-minute backoff without changing heartbeat or retry settings', () => {
  const state = connectionHarness();
  state.run('_consecutiveFailures = 11; scheduleReconnect();');
  assert.equal([...state.timers.values()][0].delay, 300_000);
  state.run('_resumeMonitor.onResume(60_000);');
  assert.equal(state.sockets.length, 1);
  assert.equal(state.run('_consecutiveFailures'), 0);
  assert.equal(state.run('_reconnectTimer'), null);
  assert.deepEqual([...state.timers.values()].map((timer) => timer.delay), [15_000]);
  state.sockets[0].readyState = 1;
  state.sockets[0].emit('open');
  assert.deepEqual([...state.timers.values()].map((timer) => timer.delay), [240_000]);
  state.run('scheduleReconnect();');
  assert.equal([...state.timers.values()].at(-1).delay, 5000);
});

test('wake safely replaces an in-flight socket and its watchdog', () => {
  const state = connectionHarness();
  state.run('connect();');
  const oldSocket = state.sockets[0];
  state.run('_resumeMonitor.onResume(60_000);');
  assert.equal(oldSocket.readyState, 3);
  assert.equal(state.sockets.length, 2);
  assert.equal(state.timers.size, 1);
  assert.equal(state.run('_consecutiveFailures'), 0);
  oldSocket.emit('error', new Error('late termination error'));
  oldSocket.emit('close', 1006);
  assert.equal(state.timers.size, 1);
});
