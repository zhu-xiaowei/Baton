import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

test('Codex child views hide only the inherited parent prompt', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId: 'codex:child' });
  h.state.appState.runtime = 'codex';
  h.state.rootSessionId = 'codex:root';
  h.state.activeThreadId = 'codex:child';
  h.state.sessionThreads = [{
    sessionId: 'codex:root',
    preview: 'parent task',
  }, {
    sessionId: 'codex:child',
    parentSessionId: 'codex:root',
    preview: 'child task',
  }];
  const parent = { type: 'user', content: 'parent task' };
  const child = { type: 'user', content: 'child task' };
  const answer = { type: 'assistant', content: 'done' };
  const messages = [parent, child, answer];

  assert.equal(h.window.shouldHideSessionMessage(parent, messages), true);
  assert.equal(h.window.shouldHideSessionMessage(child, messages), false);
  assert.equal(h.window.shouldHideSessionMessage(answer, messages), false);
});
