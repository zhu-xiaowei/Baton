import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, resetSession } from './harness.mjs';
import { LiveTurnStream } from '../../bridge/live-turn-stream.mjs';
import { LiveExecutionStream } from '../../bridge/live-execution-stream.mjs';

const h = await makeHarness();
test.after(() => h.window.close());

test('Goal continuations render after existing conversation without fabricating a user message', async () => {
  const sessionId = 'codex:goal-stream';
  resetSession(h, { sessionId });
  const container = h.document.querySelector('.messages');
  container.innerHTML = '<div class="msg-user" data-anchor="original"><div class="msg-text">Original task</div></div>';
  const frames = [];
  const turn = new LiveExecutionStream({
    sessionId, turnId: 'autonomous', goalContinuation: true,
    send: frame => { frames.push(frame); h.hooks.handleWsMessage(frame); },
  });
  turn.sendBlockStart({ blockId: 0, kind: 'text' });
  turn.sendDelta({ blockId: 0, chunk: 'Goal continues with the next step.' });
  turn.sendBlockStop({ blockId: 0 });
  await h.tick(100);
  assert.match(container.textContent, /Goal continues with the next step/);
  assert.equal(container.querySelectorAll('.msg-user').length, 1);
  assert.equal(frames.every(frame => frame.goalContinuation === true), true);
  turn.sendEnd({});
  await h.tick(20);
});

test('ordinary turns still wait for their own missing user anchor', async () => {
  const sessionId = 'codex:goal-stream';
  resetSession(h, { sessionId });
  const container = h.document.querySelector('.messages');
  container.innerHTML = '<div class="msg-user" data-anchor="unrelated">Another task</div>';
  const turn = new LiveTurnStream({
    sessionId, turnId: 'ordinary',
    send: frame => h.hooks.handleWsMessage(frame),
  });
  turn.sendBlockStart({ blockId: 0, kind: 'text' });
  turn.sendDelta({ blockId: 0, chunk: 'Should wait' });
  await h.tick(30);
  assert.doesNotMatch(container.textContent, /Should wait/);
  turn.sendEnd({});
  await h.tick(30);
});

test('joining an already-running Goal at a later block still shows its continuation', async () => {
  const sessionId = 'codex:goal-stream';
  resetSession(h, { sessionId });
  const container = h.document.querySelector('.messages');
  container.innerHTML = '<div class="msg-user" data-anchor="original">Original task</div>';
  for (const frame of [
    { action: 'stream_block_start', seq: 6, kind: 'text' },
    { action: 'stream_delta', seq: 7, chunk: 'Rejoined Goal output' },
    { action: 'stream_block_stop', seq: 8 },
  ]) h.hooks.handleWsMessage({ sessionId, turnId: 'rejoined', goalContinuation: true, ...frame });
  await h.tick(100);
  assert.match(container.textContent, /Rejoined Goal output/);
  h.hooks.handleWsMessage({ action: 'stream_end', sessionId, turnId: 'rejoined', seq: 9, goalContinuation: true });
  await h.tick(30);
});
