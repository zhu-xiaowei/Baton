import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness, resetSession } from './harness.mjs';
import { LiveExecutionStream } from '../../bridge/live-execution-stream.mjs';

// Frames come from the real Bridge LiveExecutionStream; the App side is the real ws.js.
test('a mid-turn send keeps its bubble node while the runtime consumes it', async () => {
  const h = await makeHarness();
  const sessionId = 'codex:steer';
  resetSession(h, { sessionId });
  h.state.activeThreadCanSend = true;
  h.state.stagedImages = [];
  const appSent = [];
  h.state.ws = { readyState: WebSocket.OPEN, send(p) { appSent.push(JSON.parse(p)); }, close() {} };
  const frames = [];
  const exec = new LiveExecutionStream({ sessionId, turnId: '', send: (e) => frames.push(structuredClone(e)) });
  let delivered = 0;
  const pump = async () => {
    while (delivered < frames.length) h.hooks.handleWsMessage(frames[delivered++]);
    await h.tick(10);
  };
  const userRow = (turnId, text) => ({ uuid: 'u-' + turnId, nativeId: 'codex:user:' + turnId, type: 'user', content: text, timestamp: new Date().toISOString() });

  // Turn A starts.
  h.window.doSend('first', 'first', []);
  const A = appSent.at(-1).turnId;
  exec.executionId = A;
  exec.options.turnId = A;
  h.hooks.handleWsMessage({ action: 'send_message_received', turnId: A });
  exec.registerInput(A);
  exec.sendAuthoritative(userRow(A, 'first'));
  exec.sendBlockStart({ kind: 'text', blockId: 1 });
  exec.sendDelta({ chunk: 'working on it', blockId: 1 });
  h.hooks.handleWsMessage({ action: 'send_message_result', turnId: A, sessionId, ok: true });
  await pump();

  // Mid-turn send B.
  h.window.doSend('second', 'second', []);
  const B = appSent.filter(m => m.action === 'send_message').at(-1).turnId;
  h.hooks.handleWsMessage({ action: 'send_message_received', turnId: B });
  h.hooks.handleWsMessage({ action: 'send_message_result', turnId: B, sessionId, ok: true });
  await h.tick(10);
  const bubbleB = h.document.getElementById(B);
  assert.ok(bubbleB && !bubbleB.hidden, 'B shown after receipt');

  const removals = [];
  const observer = new h.window.MutationObserver((records) => {
    for (const r of records) for (const n of r.removedNodes) {
      if (n.nodeType === 1 && (n.dataset?.anchor === B || n.querySelector?.(`[data-anchor="${B}"]`))) removals.push(n);
    }
  });
  observer.observe(h.document.getElementById('content'), { childList: true, subtree: true });

  // Runtime consumes B mid-turn.
  exec.registerInput(B);
  exec.sendAuthoritative(userRow(B, 'second'));
  await pump();
  observer.disconnect();
  const nowB = [...h.document.querySelectorAll('.msg-user')].filter(el => el.textContent.includes('second'));
  assert.equal(removals.length, 0);
  assert.ok(h.document.contains(bubbleB));
  assert.equal(nowB.length, 1);
  assert.equal(h.state.pendingSentMessages.some(p => p.id === B), false);
});
