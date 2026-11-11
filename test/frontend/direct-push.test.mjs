import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness, resetSession } from './harness.mjs';

test('pushed events enter the unchanged history barrier, sequence queue and stream renderer', async context => {
  const harness = await makeHarness();
  const sessionId = 'codex:direct-session';
  resetSession(harness, { sessionId });
  const sent = [];
  harness.state.ws = { readyState: 1, send(payload) { sent.push(JSON.parse(payload)); }, close() {} };
  context.after(() => { harness.window.disconnectWs(); harness.window.close(); });
  const turnId = 'direct-turn';
  const user = { uuid: 'direct-user', nativeId: `codex:user:${turnId}`, type: 'user', content: 'question' };
  const answer = { uuid: 'direct-answer', type: 'assistant', content: [{ type: 'text', text: 'direct answer' }] };
  const events = [
    { action: 'stream_turn_start' },
    { action: 'messages', messages: [user] },
    { action: 'stream_block_start', kind: 'text' },
    { action: 'stream_delta', chunk: 'direct answer' },
    { action: 'stream_block_stop' },
    { action: 'messages', messages: [answer] },
    { action: 'stream_end', messages: [user, answer] },
  ].map((message, seq) => ({ sessionId, turnId, seq, ...message }));
  for (const index of [0, 1, 3, 2, 5, 4, 6]) harness.bridge.push(events[index]);
  await harness.tick(150);
  const turn = harness.document.querySelector(`[data-turn-id="${turnId}"]`);
  assert.ok(turn);
  assert.equal(turn.textContent.split('direct answer').length - 1, 1);
  assert.equal(turn.classList.contains('stream-committed'), true);
  assert.ok(harness.document.querySelector(`.msg-user[data-anchor="${turnId}"]`));

  harness.state.appState.runtime = 'claude';
  const lostTurnId = 'claude-lost-end';
  const lostUser = { uuid: 'lost-user', turnId: lostTurnId, type: 'user', content: 'next question' };
  const lostAnswer = { uuid: 'lost-answer', turnId: lostTurnId, type: 'assistant', content: 'recovered answer' };
  for (const [seq, message] of [
    { action: 'stream_turn_start' },
    { action: 'messages', messages: [lostUser] },
    { action: 'stream_block_start', kind: 'text' },
  ].entries()) harness.bridge.push({ sessionId, turnId: lostTurnId, seq, ...message });
  await harness.tick(50);
  assert.equal(harness.state.wsRunning, true);
  let recoveryRequests = 0;
  harness.setApiHandler(() => {
    recoveryRequests++;
    return recoveryRequests === 1
      ? { messages: [user, answer, lostUser], status: 'running' }
      : { messages: [user, answer, lostUser, lostAnswer], status: 'completed' };
  });
  sent.length = 0;
  harness.bridge.resync('D');
  await harness.tick(50);
  assert.equal(recoveryRequests, 1, 'a reconnect reloads the history even without stream_end');
  assert.ok(sent.some(frame => frame.action === 'subscribe' && frame.sessionId === sessionId && frame.device === 'D'),
    'and subscribes again');
  assert.equal(harness.state.wsRunning, true);
  harness.bridge.resync('other-device');
  await harness.tick(50);
  assert.equal(recoveryRequests, 1, 'another device coming back does not reload this Session');
  harness.bridge.resync();
  await harness.tick(50);
  assert.equal(recoveryRequests, 2, 'the next resync brings what completed during the gap');
  assert.match(harness.document.querySelector('.messages').textContent, /recovered answer/);
  assert.equal(harness.state.wsRunning, false);

  harness.window.doSend('pending before data gap', 'pending before data gap', []);
  const pending = harness.state.pendingSentMessages[0];
  harness.bridge.resync();
  await harness.tick(50);
  assert.equal(recoveryRequests, 3);
  assert.equal(harness.state.pendingSentMessages.includes(pending), true);
  assert.equal(harness.document.getElementById(pending.id)?.isConnected, true);
  assert.equal(harness.state.wsRunning, true, 'recovering an old answer must not complete a pending question');
});
