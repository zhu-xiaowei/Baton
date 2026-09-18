import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexArchive } from '../../../bridge/codex-archive.mjs';
import { discoverCodexSessions } from '../../../bridge/codex-session.mjs';
import { CodexWatcher } from '../../../bridge/codex-watcher.mjs';

function fixture(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-native-status-'));
  const id = randomUUID();
  const directory = path.join(home, 'sessions');
  fs.mkdirSync(directory);
  const filePath = path.join(directory, `rollout-2026-09-18T00-00-00-${id}.jsonl`);
  const timestamp = '2026-09-18T00:00:00.000Z';
  fs.writeFileSync(filePath, [
    { type: 'session_meta', payload: { id, cwd: home } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Long-running native task' } },
  ].map((entry) => JSON.stringify({ timestamp, ...entry })).join('\n') + '\n');
  const old = new Date(Date.now() - 60 * 60_000);
  fs.utimesSync(filePath, old, old);
  const row = { id, cwd: home, path: filePath, status: { type: 'active', activeFlags: [] } };
  const calls = [];
  const uploads = [];
  const client = new EventEmitter();
  client.socketTransport = { writable: true };
  client.start = async () => {};
  client.stop = async () => {};
  client.request = async (method, params) => {
    calls.push({ method, params });
    assert.equal(method, 'thread/list', 'Status observation must not resume or mutate a thread');
    return { data: params.archived ? [] : [{ ...row }], nextCursor: null };
  };
  const archive = new CodexArchive({
    homes: [home], stateFile: path.join(home, 'observations.json'),
    clientFactory: () => client, probe: async () => ({ supported: true }),
    sync: async (records) => uploads.push(records),
    ...options,
  });
  const catalog = () => discoverCodexSessions({
    codexHomes: [home], runningInfo: { projects: new Set(), sessions: new Set() },
  });
  t.after(async () => {
    await archive.stop();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, id, filePath, row, client, calls, uploads, archive, catalog };
}

test('startup keeps a managed native active thread running without a matching process or fresh log', async (t) => {
  const { archive, catalog } = fixture(t);
  await archive.start();
  assert.equal(catalog().sessions[0].status, 'running');
});

test('status notifications survive a failed catalog refresh without waiting for another log append', async (t) => {
  const { archive, catalog, client, id } = fixture(t);
  await archive.start();
  client.request = async () => { throw new Error('Disconnected during snapshot'); };
  client.emit('notification', {
    method: 'thread/status/changed',
    params: { threadId: id, status: { type: 'active', activeFlags: ['waitingOnApproval'] } },
  });
  await archive.refresh();
  assert.equal(catalog().sessions[0].status, 'needs_input');
});

test('periodic snapshots re-publish a previously completed session when native work resumes', async (t) => {
  const { archive, catalog, row, uploads } = fixture(t);
  row.status = { type: 'idle' };
  await archive.start();
  assert.equal(catalog().sessions[0].status, 'completed');
  uploads.length = 0;
  row.status = { type: 'active', activeFlags: ['waitingOnUserInput'] };
  await archive.refresh();
  assert.equal(catalog().sessions[0].status, 'needs_input');
  assert.equal(uploads.at(-1)[0].runtimeStatus, 'needs_input');
});

test('unknown/notLoaded snapshots and read failures preserve confirmed active state', async (t) => {
  const { archive, catalog, row, client } = fixture(t);
  await archive.start();
  const version = catalog().sessions[0].statusVersion;
  for (const type of ['notLoaded', 'systemError', 'futureUnknownState']) {
    row.status = { type };
    await archive.refresh();
    assert.equal(catalog().sessions[0].status, 'running');
    assert.equal(catalog().sessions[0].statusVersion, version);
  }
  client.request = async () => { throw new Error('Read failed'); };
  await archive.refresh();
  assert.equal(catalog().sessions[0].status, 'running');
});

test('watcher forced process rechecks cannot downgrade a shared managed active thread', async (t) => {
  const { archive, catalog, home, filePath } = fixture(t);
  await archive.start();
  const posts = [];
  const watcher = new CodexWatcher({ deviceName: 'local-test' }, {
    codexHomes: [home], initialSessions: catalog().sessions,
    recentSessions: new Set(), lastKnownStatus: new Map(), knownProjects: new Set(),
    watermarks: new Map(),
    runningInfoFn: () => ({ projects: new Set(), sessions: new Set() }),
    postFn: async (endpoint, body) => { posts.push(body); },
    deliverFn: async () => {}, uploadFn: async () => {}, reconcileFn: async () => {},
  });
  t.after(() => watcher.stop());
  await watcher.processFile(filePath, { forceStatus: true });
  assert.ok(posts.length > 0);
  assert.ok(posts.every((body) => body.sessions.every((session) => session.status === 'running')));
});

test('read-only status discovery remains enabled when native archive mutations are unsupported', async (t) => {
  const { archive, catalog } = fixture(t, { probe: async () => ({ supported: false }) });
  await archive.start();
  assert.equal(archive.supported, false);
  assert.equal(catalog().sessions[0].status, 'running');
});

test('an independent stdio idle observation never overrides known managed activity', async (t) => {
  const { archive, catalog, client, row } = fixture(t);
  await archive.start();
  client.socketTransport = null;
  row.status = { type: 'idle' };
  await archive.refresh();
  assert.equal(catalog().sessions[0].status, 'running');
});

test('a status event racing an old paginated snapshot is not overwritten', async (t) => {
  const { archive, catalog, row, client, id } = fixture(t);
  await archive.start();
  const request = client.request;
  let raced = false;
  client.request = async (method, params) => {
    const result = await request(method, params);
    if (params.archived && !raced) {
      raced = true;
      row.status = { type: 'idle' };
      client.emit('notification', { method: 'thread/status/changed', params: { threadId: id, status: row.status } });
    }
    return result;
  };
  await archive.refresh();
  assert.equal(catalog().sessions[0].status, 'completed');
});

test('restart and a failed native read keep the last confirmed status until calibration', async (t) => {
  const { archive, catalog, home, client } = fixture(t);
  await archive.start();
  await archive.stop();
  client.request = async () => { throw new Error('Managed server temporarily offline'); };
  const restarted = new CodexArchive({
    homes: [home], stateFile: path.join(home, 'observations.json'),
    clientFactory: () => client, probe: async () => ({ supported: true }),
  });
  t.after(() => restarted.stop());
  await restarted.start();
  assert.equal(catalog().sessions[0].status, 'running');
});
