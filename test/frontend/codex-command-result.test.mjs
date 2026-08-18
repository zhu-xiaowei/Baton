import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

test('local command output promotes its exact turn bubble atomically', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId: 'codex:command-result' });
  h.state.appState.runtime = 'codex';
  h.window.doSend('/permissions full-access', '/permissions full-access', []);
  const pending = h.state.pendingSentMessages[0];

  h.hooks.handleWsMessage({
    action: 'send_message_result',
    sessionId: h.state.wsSessionId,
    turnId: pending.id,
    ok: true,
    commandOutput: 'Permissions changed to **full-access**.',
  });
  await h.tick();

  assert.equal(h.state.pendingSentMessages.length, 0);
  assert.equal(h.state.wsRunning, false);
  assert.equal(
    h.document.getElementById(pending.id).hasAttribute('data-pending'),
    false,
  );
  const output = h.state.wsAllMessages.find(
    (message) => message.uuid === `codex-command:${pending.id}`,
  );
  assert.equal(output.turnId, pending.id);
  assert.match(h.document.querySelector('.assistant-text').textContent, /full-access/);
});
