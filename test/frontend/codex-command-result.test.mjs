import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness, resetSession } from './harness.mjs';

test('local command output promotes its bubble and renders atomically', async () => {
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

  resetSession(harness, { sessionId: 'claude-session-1' });
  harness.state.appState.runtime = 'claude';
  harness.state.ws = null;
  harness.window.doSend('/model default', '/model default', []);
  const claudePending = harness.state.pendingSentMessages[0];
  harness.hooks.handleWsMessage({
    action: 'messages',
    sessionId: 'claude-session-1',
    streamId: 'stream-claude-model',
    messages: [{
      uuid: 'claude-local-model',
      type: 'assistant',
      content: [{ type: 'text', text: 'Set model to Opus for this session only' }],
    }],
  });
  await harness.tick();
  harness.hooks.handleWsMessage({
    action: 'send_message_result',
    sessionId: 'claude-session-1',
    ok: true,
    clientId: claudePending.id,
    streamId: 'stream-claude-model',
    commandOutput: 'Set model to Opus for this session only',
  });
  await harness.tick();
  assert.equal(harness.state.pendingSentMessages.length, 0);
  assert.equal(harness.state.wsRunning, false);
  assert.equal(
    harness.state.wsAllMessages.filter((message) => (
      message.type === 'assistant'
      && message.content?.[0]?.text === 'Set model to Opus for this session only'
    )).length,
    1,
  );
  assert.match(
    harness.document.querySelector('.assistant-text').textContent,
    /Opus/,
  );

  resetSession(harness, { sessionId: 'claude-session-usage' });
  harness.state.appState.runtime = 'claude';
  harness.state.ws = null;
  harness.window.doSend('/usage', '/usage', []);
  const usagePending = harness.state.pendingSentMessages[0];
  harness.hooks.handleWsMessage({
    action: 'send_message_result',
    sessionId: 'claude-session-usage',
    ok: true,
    clientId: usagePending.id,
    streamId: 'stream-claude-usage',
    commandOutput: 'Claude Code settings',
    commandPanel: {
      type: 'claude-usage',
      initialTab: 'usage',
    },
  });
  await harness.tick();
  assert.equal(harness.state.pendingSentMessages.length, 0);
  assert.equal(harness.state.wsRunning, false);
  assert.equal(
    harness.state.wsAllMessages.find((message) => message._streamId === 'stream-claude-usage')
      ._commandPanel.type,
    'claude-usage',
  );

  resetSession(harness, { sessionId: 'codex:thread-1' });
  harness.state.appState.runtime = 'codex';
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
