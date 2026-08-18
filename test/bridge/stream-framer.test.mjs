import assert from 'node:assert/strict';
import test from 'node:test';

import { StreamFramer } from '../../bridge/stream-framer.mjs';

function framer(options = {}) {
  const frames = [];
  return {
    frames,
    value: new StreamFramer((frame) => frames.push(frame), {
      batchMs: 50,
      setTimer: () => 1,
      clearTimer: () => {},
      ...options,
    }),
  };
}

test('framer preserves block boundaries without assigning transport sequence', () => {
  const { value, frames } = framer();
  value.start(0, 'text');
  value.delta(0, 'A');
  value.delta(0, 'BC');
  value.stop(0);

  assert.deepEqual(frames, [
    { t: 'start', blockId: 0, kind: 'text', name: null },
    { t: 'delta', blockId: 0, chunk: 'A' },
    { t: 'delta', blockId: 0, chunk: 'BC' },
    { t: 'stop', blockId: 0 },
  ]);
  assert.equal(frames.some((frame) => 'seq' in frame), false);
});

test('framer flushes pending data before another block starts', () => {
  const { value, frames } = framer();
  value.start(0, 'text');
  value.delta(0, 'A');
  value.start(1, 'tool_use', 'Bash');
  value.input(1, '{"command":"pwd"}');
  value.finish();

  assert.deepEqual(frames.map((frame) => frame.t), [
    'start', 'delta', 'start', 'input',
  ]);
  assert.deepEqual(frames.map((frame) => frame.blockId), [0, 0, 1, 1]);
});

test('framer splits oversized UTF-8 chunks without breaking characters', () => {
  const { value, frames } = framer({ maxChunkBytes: 7 });
  value.delta(0, '你好世界');
  value.finish();

  assert.equal(frames.length, 2);
  assert.equal(frames.map((frame) => frame.chunk).join(''), '你好世界');
  assert.ok(frames.every((frame) => Buffer.byteLength(frame.chunk) <= 7));
});
