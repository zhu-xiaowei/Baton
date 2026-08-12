import assert from 'node:assert/strict';
import test from 'node:test';
import {
  creatableRuntimes,
  newSessionRuntimePreferenceKey,
  nextNewSessionRuntime,
  preferredNewSessionRuntime,
} from '../../web/js/new-session-runtime.js';
import { makeHarness } from './harness.mjs';

test('single creatable runtime is selected without requiring a choice', () => {
  const runtimes = creatableRuntimes({
    claude: { canCreate: false },
    codex: { canCreate: true },
  });
  assert.deepEqual(runtimes, ['codex']);
  assert.equal(preferredNewSessionRuntime(runtimes, 'claude'), 'codex');
  assert.equal(nextNewSessionRuntime(runtimes, 'codex'), 'codex');
});

test('multiple runtimes prefer the last valid per-device choice and cycle', () => {
  const runtimes = creatableRuntimes({
    claude: { canCreate: true },
    codex: { canCreate: true },
  });
  assert.deepEqual(runtimes, ['claude', 'codex']);
  assert.equal(preferredNewSessionRuntime(runtimes, 'codex'), 'codex');
  assert.equal(preferredNewSessionRuntime(runtimes, 'other'), 'claude');
  assert.equal(nextNewSessionRuntime(runtimes, 'claude'), 'codex');
  assert.equal(nextNewSessionRuntime(runtimes, 'codex'), 'claude');
  assert.equal(
    newSessionRuntimePreferenceKey('MacBook-Pro'),
    'apeek_new_session_runtime:MacBook-Pro',
  );
});

test('new Codex session sends the selected runtime to the Bridge', async () => {
  const harness = await makeHarness();
  const sent = [];
  harness.state.ws = {
    readyState: WebSocket.OPEN,
    send(raw) {
      sent.push(JSON.parse(raw));
    },
  };
  harness.state.appState = {
    device: 'MacBook-Pro',
    project: { hash: '-workspace-project' },
    session: '__new__',
    runtime: 'codex',
  };
  harness.state.wsProjectHash = '-workspace-project';
  harness.state.wsRequestId = 'create-codex';

  harness.window.doSend('hello', 'hello', []);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, 'send_message');
  assert.equal(sent[0].runtime, 'codex');
  assert.equal(sent[0].asAgent, false);
  assert.equal(sent[0].projectHash, '-workspace-project');
});
