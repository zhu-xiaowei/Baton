import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { CodexArchive } from '../../../bridge/codex-archive.mjs';
import { CodexAppServerClient } from '../../../bridge/codex-app-server.mjs';
import { resolveCodexBin } from '../../../bridge/runtime-capabilities.mjs';
import { discoverCodexSessions, findCodexSessionFile } from '../../../bridge/codex-session.mjs';
import { canInspectCodexArchiveWriters, inspectCodexArchiveWriter } from '../../../bridge/codex-writer.mjs';

test('installed Codex archives an isolated rollout and history remains readable without resume', {
  skip: !resolveCodexBin() || !canInspectCodexArchiveWriters(),
  timeout: 60_000,
}, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-native-archive-'));
  const directory = path.join(home, 'sessions', '2026', '09', '16');
  fs.mkdirSync(directory, { recursive: true });
  const id = randomUUID();
  const timestamp = '2026-09-16T00:00:00.000Z';
  const rollout = path.join(directory, `rollout-2026-09-16T00-00-00-${id}.jsonl`);
  fs.writeFileSync(rollout, [
    { timestamp, type: 'session_meta', payload: {
      id, session_id: id, timestamp, cwd: home, originator: 'codex_cli_rs',
      cli_version: '0.154.0', source: 'cli', model_provider: 'openai',
    } },
    { timestamp, type: 'event_msg', payload: {
      type: 'user_message', message: 'Isolated archive contract fixture',
      images: [], local_images: [], text_elements: [],
    } },
    { timestamp, type: 'response_item', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Isolated archive contract fixture' }],
    } },
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  const methods = [];
  const archive = new CodexArchive({
    homes: [home], stateFile: path.join(home, 'baton-archives.json'),
    clientFactory: (targetHome) => {
      const client = new CodexAppServerClient({
        cwd: targetHome, codexHomes: [targetHome], socketPath: false,
        env: { ...process.env, CODEX_HOME: targetHome }, requestTimeout: 10_000,
      });
      const request = client.request.bind(client);
      client.request = (method, params) => { methods.push(method); return request(method, params); };
      return client;
    },
    sync: async () => {},
  });
  t.after(async () => { await archive.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  await archive.start();
  if (!archive.supported) { t.skip('Installed protocol does not expose archive methods'); return; }
  assert.equal(archive.lookup(id)?.archiveState, 'unarchived');
  if (process.platform === 'linux') {
    const lockDir = path.join(home, 'thread-writer-locks');
    fs.mkdirSync(lockDir, { recursive: true });
    const fd = fs.openSync(path.join(lockDir, `${id}.lock`), 'w');
    try {
      assert.equal(inspectCodexArchiveWriter(id, home, { proc: process }, { status: { type: 'idle' } }).occupied, true);
      assert.equal((await archive.setArchived(id, true)).errorCode, 'archive_writer_busy');
    } finally { fs.closeSync(fd); }
  }
  const archived = await archive.setArchived(id, true);
  assert.equal(archived.ok, true, JSON.stringify(archived));
  const file = findCodexSessionFile(id, { codexHomes: [home] });
  assert.ok(file && fs.existsSync(file));
  assert.notEqual(file, rollout);
  assert.ok(fs.readFileSync(file, 'utf8').includes('Isolated archive contract fixture'));
  const catalog = discoverCodexSessions({ codexHomes: [home], runningInfo: { projects: new Set(), sessions: new Set() } });
  assert.equal(catalog.sessions.find((session) => session.nativeSessionId === id)?.archiveState, 'archived');
  const restored = await archive.setArchived(id, false);
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.equal(archive.lookup(id).archiveState, 'unarchived');
  const external = new CodexAppServerClient({
    cwd: home, codexHomes: [home], socketPath: false,
    env: { ...process.env, CODEX_HOME: home }, requestTimeout: 10_000,
  });
  try {
    await external.request('thread/archive', { threadId: id });
    await archive.refresh();
    assert.equal(archive.lookup(id).archiveState, 'archived');
    await external.request('thread/unarchive', { threadId: id });
    await archive.refresh();
    assert.equal(archive.lookup(id).archiveState, 'unarchived');
  } finally { await external.stop(); }
  assert.equal(methods.some((method) => method.includes('resume') || method.startsWith('turn/')), false);
});

test('installed Codex cannot archive a parent with an unlisted pending descendant', {
  skip: !resolveCodexBin() || !canInspectCodexArchiveWriters(),
  timeout: 60_000,
}, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-native-hidden-child-'));
  const directory = path.join(home, 'sessions', '2026', '09', '16');
  fs.mkdirSync(directory, { recursive: true });
  const root = randomUUID(), child = randomUUID();
  const timestamp = '2026-09-16T00:00:00.000Z';
  for (const id of [root, child]) {
    const entries = [{ timestamp, type: 'session_meta', payload: {
      id, session_id: id, timestamp, cwd: home, originator: 'codex_cli_rs',
      cli_version: '0.154.0', model_provider: 'openai',
      source: id === root ? 'cli' : { subagent: { thread_spawn: { parent_thread_id: root, depth: 1 } } },
      ...(id === child ? { parent_thread_id: root } : {}),
    } }];
    if (id === root) entries.push({ timestamp, type: 'event_msg', payload: {
      type: 'user_message', message: 'Isolated ancestor safety fixture',
      images: [], local_images: [], text_elements: [],
    } });
    entries.push({ timestamp, type: 'response_item', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Isolated topology fixture' }],
    } });
    fs.writeFileSync(path.join(directory, `rollout-2026-09-16T00-00-00-${id}.jsonl`),
      entries.map(JSON.stringify).join('\n') + '\n');
  }
  const methods = [];
  const archive = new CodexArchive({
    homes: [home], stateFile: path.join(home, 'baton-archives.json'), sync: async () => {},
    clientFactory: () => {
      const client = new CodexAppServerClient({
        cwd: home, codexHomes: [home], socketPath: false,
        env: { ...process.env, CODEX_HOME: home }, requestTimeout: 10_000,
      });
      const request = client.request.bind(client);
      client.request = (method, params) => { methods.push(method); return request(method, params); };
      return client;
    },
  });
  t.after(async () => { await archive.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  await archive.start();
  if (!archive.supported) { t.skip('Installed protocol does not expose archive methods'); return; }
  assert.ok(archive.lookup(root));
  const release = archive.trackPendingSend(child);
  assert.equal((await archive.setArchived(root, true)).errorCode, 'session_active');
  release();
  if (!archive.lookup(child)) {
    assert.equal((await archive.setArchived(root, true)).errorCode, 'archive_state_unknown');
  }
  assert.equal(archive.lookup(root).archiveState, 'unarchived');
  assert.ok(fs.existsSync(path.join(directory, `rollout-2026-09-16T00-00-00-${child}.jsonl`)));
  assert.equal(methods.some((method) => !['thread/list', 'thread/read'].includes(method)), false);
});
