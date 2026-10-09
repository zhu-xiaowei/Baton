import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import WebSocket, { WebSocketServer } from 'ws';
import { once } from 'node:events';

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

function connectionHarness(options = {}) {
  const source = fs.readFileSync(new URL('../../bridge/ws.mjs', import.meta.url), 'utf8');
  const stateStart = source.indexOf('let _ws = null;');
  const stateEnd = source.indexOf('// onExit only fires', stateStart);
  const connectStart = source.indexOf('function probeConnection() {');
  const connectEnd = source.indexOf('async function handleMessage', connectStart);
  assert.ok(stateStart >= 0 && stateEnd > stateStart && connectStart > stateEnd && connectEnd > connectStart);
  const sockets = [];
  const timers = new Map();
  let timerId = 1;
  class FakeSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;
    constructor(url) {
      super();
      this.url = url;
      this.messages = [];
      this.readyState = 0;
      sockets.push(this);
    }
    terminate() { this.readyState = 3; this.emit('error', new Error('terminated during handshake')); }
    send(data) { this.sent = JSON.parse(data); this.messages.push(this.sent); }
    ping(data) { this.pingData = data; }
  }
  const context = vm.createContext({
    WebSocket: options.live ? WebSocket : FakeSocket, SleepGapMonitor, RealtimeSender,
    console: { log() {}, error() {} }, process: { platform: process.platform }, BRIDGE_VERSION: 'test',
    _terminalRemote: null, _sharedTerminals: null, _previewBridge: null,
    handleMessage: async () => {},
    setTimeout: (callback, delay) => { const id = timerId++; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (callback, delay) => { const id = timerId++; timers.set(id, { callback, delay }); return id; },
    clearInterval: (id) => timers.delete(id),
    ...(options.live ? { setTimeout, clearTimeout, setInterval, clearInterval } : {}),
  });
  vm.runInContext(source.slice(stateStart, stateEnd) + source.slice(connectStart, connectEnd), context);
  vm.runInContext("_config = { wsUrl: 'ws://localhost', apiKey: 'test', deviceName: 'test' };", context);
  return { sockets, timers, run: (code) => vm.runInContext(code, context) };
}

test('retries stay bounded and duplicate connects preserve a responsive connection', () => {
  const state = connectionHarness();
  state.run('_consecutiveFailures = 11; scheduleReconnect();');
  assert.equal([...state.timers.values()][0].delay, 5000);
  state.run('connect(); connect();');
  assert.equal(state.sockets.length, 1);
  assert.equal(state.run('_consecutiveFailures'), 12);
  assert.equal(state.run('_reconnectTimer'), null);
  assert.deepEqual([...state.timers.values()].map((timer) => timer.delay), [5000]);
  state.sockets[0].readyState = 1;
  state.sockets[0].emit('open');
  assert.equal(new URL(state.sockets[0].url).searchParams.get('heartbeat'), '240');
  assert.deepEqual([...state.timers.values()].map((timer) => timer.delay), [240000, 20000, 5000, 10000]);
  const oldPing = state.sockets[0].pingData;
  state.run('connect();');
  assert.equal(state.sockets.length, 1);
  assert.deepEqual(state.sockets[0].sent, { action: 'heartbeat' });
  state.sockets[0].emit('pong', oldPing);
  state.timers.get(state.run('_pingTimer')).callback();
  state.sockets[0].emit('pong', oldPing);
  assert.ok(state.run('_resumeProbeTimer'));
  state.sockets[0].emit('pong', state.sockets[0].pingData);
  assert.equal(state.run('_resumeProbeTimer'), null);
  assert.ok(state.run('_heartbeatTimeout'));
  state.sockets[0].emit('message', JSON.stringify({ action: 'heartbeat' }));
  assert.equal(state.run('_heartbeatTimeout'), null);
  assert.equal(state.run('_consecutiveFailures'), 0);
  assert.deepEqual([...state.timers.values()].map((timer) => timer.delay), [240000, 20000]);
  const messages = state.sockets[0].messages.length;
  for (let tick = 0; tick < 11; tick++) {
    state.timers.get(state.run('_pingTimer')).callback();
    state.sockets[0].emit('pong', state.sockets[0].pingData);
  }
  assert.equal(state.sockets[0].messages.length, messages);
  state.timers.get(state.run('_heartbeatTimer')).callback();
  assert.equal(state.sockets[0].messages.length, messages + 1);
  const deadline = state.timers.get(state.run('_heartbeatTimeout'));
  assert.equal(deadline.delay, 10000);
  deadline.callback();
  assert.equal(state.sockets[0].readyState, 3);
  assert.equal(state.run('_heartbeatTimeout'), null);
  assert.equal(state.timers.size, 1);
  assert.equal([...state.timers.values()].at(-1).delay, 0);
});

test('duplicate connect preserves an in-flight socket until its watchdog expires', () => {
  const state = connectionHarness();
  state.run('connect();');
  const oldSocket = state.sockets[0];
  state.run('connect();');
  assert.equal(oldSocket.readyState, 0);
  assert.equal(state.sockets.length, 1);
  const watchdog = state.run('_connectWatchdog');
  const callback = state.timers.get(watchdog).callback;
  state.timers.delete(watchdog);
  callback();
  assert.equal(oldSocket.readyState, 3);
  assert.equal(state.sockets.length, 1);
  assert.equal(state.timers.size, 1);
  assert.equal(state.run('_consecutiveFailures'), 1);
  oldSocket.emit('error', new Error('late termination error'));
  oldSocket.emit('close', 1006);
  assert.equal(state.timers.size, 1);
});

test('missing pong expires once and stale socket callbacks cannot reset its replacement', () => {
  const state = connectionHarness();
  state.run('connect();');
  const oldSocket = state.sockets[0];
  oldSocket.readyState = 1;
  oldSocket.emit('open');
  const oldMessage = oldSocket.listeners('message')[0];
  const oldPong = oldSocket.listeners('pong')[0];
  const oldError = oldSocket.listeners('error')[0];
  const probe = state.run('_resumeProbeTimer');
  const timeout = state.timers.get(probe);
  assert.equal(timeout.delay, 5000);
  timeout.callback();
  const reconnect = state.run('_reconnectTimer');
  assert.equal(state.timers.get(reconnect).delay, 0);
  state.timers.get(reconnect).callback();
  const replacement = state.sockets[1];
  replacement.readyState = 1;
  replacement.emit('open');
  const replacementProbe = state.run('_resumeProbeTimer');
  oldPong(replacement.pingData);
  oldMessage(JSON.stringify({ action: 'heartbeat' }));
  oldError(new Error('late error'));
  assert.equal(state.run('_resumeProbeTimer'), replacementProbe);
  assert.equal(state.sockets.length, 2);
  replacement.emit('pong', replacement.pingData);
  assert.ok(state.run('_heartbeatTimeout'));
  replacement.emit('message', JSON.stringify({ action: 'heartbeat' }));
  assert.equal(state.run('_resumeProbeTimer'), null);
  assert.equal(state.run('_consecutiveFailures'), 0);
  state.run('_config = null; resetConnection();');
  timeout.callback();
  assert.equal(state.sockets.length, 2);
});

test('real WebSocket recovers after a twenty-second ping interval without frequent business heartbeats', { timeout: 35_000 }, async (context) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, autoPong: false });
  await once(server, 'listening');
  const state = connectionHarness({ live: true });
  context.after(async () => {
    state.run('_config = null; clearTimeout(_reconnectTimer); resetConnection();');
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  let connections = 0;
  let heartbeats = 0;
  let failureStarted = 0;
  let recovered;
  const recovery = new Promise(resolve => { recovered = resolve; });
  server.on('connection', socket => {
    const generation = ++connections;
    let pings = 0;
    socket.on('ping', data => {
      if (generation === 1 && pings++ > 0) return;
      socket.pong(data);
    });
    socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString());
      if (message.action !== 'heartbeat') return;
      heartbeats++;
      socket.send(JSON.stringify({ action: 'heartbeat' }));
      if (generation === 1) failureStarted = performance.now();
      else recovered(performance.now() - failureStarted);
    });
  });
  state.run(`_config.wsUrl = 'ws://127.0.0.1:${server.address().port}'; connect();`);
  const elapsed = await recovery;
  assert.equal(connections, 2);
  assert.equal(heartbeats, 2);
  assert.ok(elapsed >= 24000 && elapsed < 30_000, `silent connection recovery took ${elapsed}ms`);
  context.diagnostic(`silent connection recovered in ${Math.round(elapsed)}ms`);
});
