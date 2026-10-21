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

test('a question from another client keeps the earlier Goal reply above it', async () => {
  h.window.disconnectWs();
  resetSession(h, { sessionId: 'codex:goal-order' });
  h.state.rootSessionId = 'codex:goal-order';
  h.state.appState.runtime = 'codex';
  h.state.ws = { readyState: WebSocket.OPEN, send() {}, close() {} };
  h.setApiHandler(async () => ({ messages: [{
    uuid: 'initial', nativeId: 'codex:user:initial', type: 'user', content: 'Original task',
    timestamp: '2026-10-21T00:00:00Z',
  }], status: 'completed' }));
  await h.window.loadLatestMessages('codex:goal-order');
  const send = frame => h.hooks.handleWsMessage(frame);
  const text = value => [{ type: 'text', text: value }];
  const goal = new LiveExecutionStream({ sessionId: 'codex:goal-order', turnId: 'goal', goalContinuation: true, send });
  goal.sendBlockStart({ blockId: 0, kind: 'text' });
  goal.sendDelta({ blockId: 0, chunk: 'Goal output' });
  goal.sendBlockStop({ blockId: 0 });
  goal.sendAuthoritative({ uuid: 'goal-output', type: 'assistant', content: text('Goal output'), timestamp: '2026-10-21T00:00:01Z' });
  goal.sendEnd({});
  await h.tick(100);
  const remote = new LiveExecutionStream({ sessionId: 'codex:goal-order', turnId: 'remote', send });
  remote.registerInput('remote');
  remote.sendAuthoritative({ uuid: 'next', nativeId: 'codex:user:remote', type: 'user', content: 'Next question', timestamp: '2026-10-21T00:00:02Z' });
  remote.sendAuthoritative({ uuid: 'answer', type: 'assistant', content: text('Next answer'), timestamp: '2026-10-21T00:00:03Z' });
  remote.sendEnd({});
  await h.tick(200);
  const rows = Array.from(h.document.querySelectorAll('.messages > .msg-user, .messages > .assistant-turn'))
    .map(node => (node.querySelector('.msg-text') || node).textContent.trim());
  assert.deepEqual(rows, ['Original task', 'Goal output', 'Next question', 'Next answer']);
});
