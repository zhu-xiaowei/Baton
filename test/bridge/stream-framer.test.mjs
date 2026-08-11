import assert from 'node:assert/strict';
import test from 'node:test';
import { StreamFramer } from '../../bridge/stream-framer.mjs';

function clock() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer(fn) {
      const id = nextId++;
      timers.set(id, fn);
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    fire() {
      const entries = [...timers.values()];
      timers.clear();
      for (const fn of entries) fn();
    },
  };
}

test('stream framer preserves CC leading-edge batch and seq behavior', () => {
  const frames = [];
  const timer = clock();
  const framer = new StreamFramer((frame) => frames.push(frame), {
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });

  framer.start(0, 'text');
  framer.delta(0, 'A');
  framer.delta(0, 'B');
  framer.delta(0, 'C');
  timer.fire();
  framer.stop(0);

  assert.deepEqual(frames, [
    { t: 'start', blockId: 0, kind: 'text', name: null, seq: 0 },
    { t: 'delta', blockId: 0, chunk: 'A', seq: 1 },
    { t: 'delta', blockId: 0, chunk: 'BC', seq: 2 },
    { t: 'stop', blockId: 0, seq: 3 },
  ]);
  assert.equal(framer.finish(), 4);
});

test('stream framer flushes pending text before block boundaries', () => {
  const frames = [];
  const timer = clock();
  const framer = new StreamFramer((frame) => frames.push(frame), {
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  });

  framer.start(0, 'thinking');
  framer.delta(0, 'one');
  framer.delta(0, ' two');
  framer.stop(0);
  framer.start(1, 'tool_use', 'Bash');
  framer.input(1, '{"command":');
  framer.input(1, '"pwd"}');
  const finalSeq = framer.finish();

  assert.deepEqual(frames.map((frame) => [frame.t, frame.seq, frame.blockId]), [
    ['start', 0, 0],
    ['delta', 1, 0],
    ['delta', 2, 0],
    ['stop', 3, 0],
    ['start', 4, 1],
    ['input', 5, 1],
    ['input', 6, 1],
  ]);
  assert.equal(frames[2].chunk, ' two');
  assert.equal(frames[6].chunk, '"pwd"}');
  assert.equal(finalSeq, 7);
});
