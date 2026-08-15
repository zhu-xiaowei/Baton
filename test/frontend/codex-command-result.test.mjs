import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness, resetSession } from './harness.mjs';

test('Codex local command output promotes its bubble and renders atomically', async () => {
  const harness = await makeHarness();
  resetSession(harness, { sessionId: 'codex:thread-1' });
  harness.state.appState.runtime = 'codex';
  harness.window.doSend(
    '/permissions full-access',
    '/permissions full-access',
    [],
  );
  const pending = harness.state.pendingSentMessages[0];

  harness.hooks.handleWsMessage({
    action: 'send_message_result',
    sessionId: 'codex:thread-1',
    ok: true,
    clientId: pending.id,
    streamId: 'stream-permissions',
    commandOutput: 'Permissions changed to **full-access**.',
  });
  await harness.tick();

  assert.equal(harness.state.pendingSentMessages.length, 0);
  assert.equal(harness.state.wsRunning, false);
  assert.equal(
    harness.document.getElementById('send-btn').classList.contains('is-stop'),
    false,
  );
  assert.equal(
    harness.document.getElementById(pending.id).hasAttribute('data-pending'),
    false,
  );
  assert.match(
    harness.document.querySelector('.assistant-text').textContent,
    /full-access/,
  );

  harness.state.ws = null;
  harness.window.doSend('/compact', '/compact', []);
  const compactPending = harness.state.pendingSentMessages[0];
  harness.hooks.handleWsMessage({
    action: 'send_message_result',
    sessionId: 'codex:thread-1',
    ok: true,
    clientId: compactPending.id,
    streamId: 'stream-compact',
    commandNoEcho: true,
  });
  assert.equal(harness.state.pendingSentMessages.length, 0);
  assert.equal(harness.state.wsRunning, true);
  assert.equal(
    harness.document.getElementById('send-btn').classList.contains('is-stop'),
    true,
  );
  assert.equal(
    harness.document.getElementById(compactPending.id).hasAttribute('data-pending'),
    false,
  );

  resetSession(harness, { sessionId: 'codex:thread-copy' });
  harness.state.appState.runtime = 'codex';
  harness.state.stagedImages = [];
  harness.state.wsAllMessages = [{
    uuid: 'assistant-1',
    type: 'assistant',
    content: [{ type: 'text', text: 'Last response markdown' }],
  }, {
    uuid: 'local-status',
    type: 'assistant',
    content: [{ type: 'text', text: 'Local status output' }],
    _localCommand: true,
  }];
  let copied = '';
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText(value) {
        copied = value;
        return Promise.resolve();
      },
    },
  });
  const input = harness.document.getElementById('msg-input');
  input.value = '/copy';

  harness.window.sendMessage();
  await harness.tick();

  assert.equal(copied, 'Last response markdown');
  assert.equal(input.value, '');
  assert.equal(harness.state.pendingSentMessages.length, 0);
});
