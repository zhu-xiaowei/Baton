import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

const harness = await makeHarness();
const sessionId = 'codex:live-commit';
globalThis.showWsBanner = harness.window.showWsBanner = () => {};

function setup() {
  harness.window.disconnectWs();
  resetSession(harness, { sessionId });
  harness.state.appState.runtime = 'codex';
  harness.state.ws = { readyState: 1, send() {}, close() {} };
  harness.state.stickBottom = false;
}

test('live commit confirms only the matching send and keeps both user anchors', (context) => {
  setup();
  harness.window.doSend('same', 'same', []);
  harness.window.doSend('same', 'same', []);
  const [first, second] = harness.state.pendingSentMessages;
  context.after(() => {
    for (const pending of [first, second]) {
      clearTimeout(pending.transportTimer);
    }
  });
  const firstNode = harness.document.getElementById(first.id);
  const secondNode = harness.document.getElementById(second.id);
  const echo = {
    uuid: 'first-user',
    nativeId: 'codex:user:' + first.id,
    type: 'user',
    content: 'same',
  };
  harness.hooks.commitMessages([echo, {
    uuid: 'first-answer',
    turnId: first.id,
    type: 'assistant',
    content: 'answer one',
    stopReason: 'end_turn',
  }], { authoritative: true });

  assert.deepEqual(harness.state.pendingSentMessages, [second]);
  assert.equal(harness.document.querySelector('[data-anchor="' + first.id + '"]'), firstNode);
  assert.equal(harness.document.getElementById(second.id), secondNode);
  assert.equal(firstNode.dataset.messageId, 'first-user');
  assert.equal(firstNode.nextElementSibling.textContent, 'answer one');
  assert.equal(firstNode.nextElementSibling.nextElementSibling, secondNode);

  harness.hooks.commitMessages([{
    uuid: 'unrelated-user', type: 'user', content: 'same',
  }]);
  assert.deepEqual(harness.state.pendingSentMessages, [second]);
  assert.equal(harness.document.getElementById(second.id), secondNode);
});

test('live completion ends the spinner once and metadata preserves message DOM', (context) => {
  setup();
  let ended = 0;
  const previous = harness.window.markSpinnerTurnEnd;
  harness.window.markSpinnerTurnEnd = () => { ended++; };
  context.after(() => { harness.window.markSpinnerTurnEnd = previous; });
  harness.state.wsRunning = true;
  harness.hooks.commitMessages([{
    uuid: 'complete-answer',
    type: 'assistant',
    content: 'done',
    stopReason: 'end_turn',
  }]);
  const answer = harness.document.querySelector('[data-message-id="complete-answer"]');
  assert.ok(answer);
  assert.equal(harness.state.wsRunning, false);
  assert.equal(ended, 1);

  harness.hooks.commitMessages([{ uuid: 'title', type: 'ai-title', content: 'New title' }]);
  assert.equal(ended, 1);
  assert.equal(harness.document.querySelector('[data-message-id="complete-answer"]'), answer);
});
