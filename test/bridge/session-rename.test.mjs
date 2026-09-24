import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { handleSessionRename, renameNativeSession } from '../../bridge/session-rename.mjs';

const sessionId = '22222222-2222-4222-8222-222222222222';
const request = { sessionId, projectHash: 'project', name: ' New title ', requestId: 'request', replyConnectionId: 'app' };

test('rename validates names and project ownership before calling the existing Claude pool', async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-rename-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'project', `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, '{}\n');
  const calls = [];
  const options = {
    findClaudeSessionFile: () => file,
    claudePool: { renameSession: async (...args) => calls.push(args) },
  };
  for (const name of ['', '   ', 'bad\nname', 'x'.repeat(201)]) {
    await assert.rejects(renameNativeSession({ ...request, name }, options), /session name/);
  }
  await assert.rejects(renameNativeSession({ ...request, sessionId: '../escape' }, options), /Invalid session/);
  await assert.rejects(renameNativeSession({ ...request, projectHash: 'other' }, options), /belong/);
  assert.equal(calls.length, 0);
  assert.equal((await renameNativeSession(request, options)).name, 'New title');
  assert.deepEqual(calls, [[sessionId, os.homedir(), 'New title']]);
});

test('Codex rename uses only thread/name/set against the owning home and closes the client', async context => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-rename-codex-'));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'sessions');
  fs.mkdirSync(dir);
  fs.copyFileSync(new URL(`../codex/phase1/fixtures/codex/rollout-2026-08-06T00-00-00-${sessionId}.jsonl`, import.meta.url),
    path.join(dir, `rollout-2026-08-06T00-00-00-${sessionId}.jsonl`));
  const calls = [];
  let stopped = 0;
  const options = {
    codexHomes: [home],
    createCodexClient(config) {
      assert.equal(config.env.CODEX_HOME, home);
      assert.deepEqual(config.codexHomes, [home]);
      return { request: async (...args) => calls.push(args), stop: async () => { stopped++; } };
    },
  };
  await renameNativeSession({ ...request, sessionId: `codex:${sessionId}`, projectHash: '-tmp-baton-codex-target' }, options);
  assert.deepEqual(calls, [['thread/name/set', { threadId: sessionId, name: 'New title' }]]);
  assert.equal(stopped, 1);
  options.createCodexClient = () => ({
    request: async () => { throw new Error('native failure'); }, stop: async () => { stopped++; },
  });
  await assert.rejects(renameNativeSession({ ...request, sessionId: `codex:${sessionId}`, projectHash: '-tmp-baton-codex-target' }, options), /native failure/);
  assert.equal(stopped, 2);
});

test('rename acknowledges native success separately from cloud sync and never syncs native failures', async () => {
  for (const failure of ['none', 'cloud', 'native']) {
    const sent = [], posted = [];
    await handleSessionRename(request, {
      deviceName: 'Mac', send: message => sent.push(message),
      rename: async () => {
        if (failure === 'native') throw new Error('Native unavailable');
        return { sessionId, runtime: 'claude', name: 'New title' };
      },
      post: async (...args) => { posted.push(args); return { ok: failure !== 'cloud' }; },
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].replyConnectionId, 'app');
    assert.equal(sent[0].ok, failure !== 'native');
    if (failure === 'native') assert.equal(posted.length, 0);
    else {
      assert.equal(sent[0].synced, failure !== 'cloud');
      assert.deepEqual(posted[0], ['/api/bridge/session-title', {
        deviceName: 'Mac', projectHash: 'project', sessionId, name: 'New title',
      }]);
    }
  }
});
