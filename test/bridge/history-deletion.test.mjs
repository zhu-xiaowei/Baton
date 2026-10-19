import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  claudeRuntime,
  discoverClaudeSessions,
} from '../../bridge/claude-runtime.mjs';
import { codexRuntime } from '../../bridge/codex-runtime.mjs';
import { discoverCodexHistory, discoverCodexSessions } from '../../bridge/codex-session.mjs';
import { handleDeleteFiles } from '../../bridge/ws.mjs';
import { projectHashFromCwd } from '../../bridge/session-identity.mjs';

const rootId = '11111111-1111-4111-8111-111111111111';
const childId = '22222222-2222-4222-8222-222222222222';
const nestedId = '33333333-3333-4333-8333-333333333333';
const otherId = '44444444-4444-4444-8444-444444444444';
const runningInfo = { projects: new Set(), sessions: new Set() };

async function deleteHistoryFiles(request, context = {}, adapters) {
  let sent;
  await handleDeleteFiles(request, {
    context: {
      createCodexClient: () => ({ request: async () => {}, stop: async () => {} }),
      ...context,
    },
    adapters, send: (result) => { sent = result; },
  });
  return sent;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-delete-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeClaude(projectsRoot, projectHash, id) {
  const file = path.join(projectsRoot, projectHash, `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    type: 'user', message: { content: 'A test conversation' },
  }) + '\n');
  return file;
}

function writeCodex(home, cwd, id, parent = '') {
  const file = path.join(home, 'sessions', '2026', '10', `rollout-${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    { type: 'session_meta', payload: { id, cwd, ...(parent ? { parent_thread_id: parent } : {}) } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'A test conversation' } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');
  return file;
}

test('Claude project deletion removes normalized worktree directories and survives rediscovery', (t) => {
  const root = fixture(t);
  const projectsRoot = path.join(root, 'history');
  writeClaude(projectsRoot, '-repo', rootId);
  writeClaude(projectsRoot, '-repo--claude-worktrees-feature', childId);
  const keep = writeClaude(projectsRoot, '-repo-other', otherId);
  const source = path.join(root, 'source.txt');
  fs.writeFileSync(source, 'keep source');
  assert.equal(claudeRuntime.deleteProjectHistory('-repo', { projectsRoot }), true);
  const catalog = discoverClaudeSessions({ claudeProjectsRoot: projectsRoot, runningInfo, daemonMeta: new Map() });
  assert.deepEqual(catalog.sessions.map((s) => s.id), [otherId]);
  assert.equal(fs.existsSync(keep), true);
  assert.equal(fs.readFileSync(source, 'utf8'), 'keep source');
  assert.equal(claudeRuntime.deleteProjectHistory('-repo', { projectsRoot }), true);
  assert.equal(claudeRuntime.deleteProjectHistory('.', { projectsRoot }), false);
  assert.equal(claudeRuntime.deleteProjectHistory('../history', { projectsRoot }), false);
});

test('Claude session deletion removes all copies and is retryable', (t) => {
  const projectsRoot = fixture(t);
  const first = writeClaude(projectsRoot, '-repo', rootId);
  const second = writeClaude(projectsRoot, '-repo--claude-worktrees-feature', rootId);
  const keep = writeClaude(projectsRoot, '-repo', otherId);
  const context = { projectsRoot };
  assert.equal(claudeRuntime.deleteSessionHistory(rootId, context), true);
  for (const file of [first, second]) assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(keep), true);
  assert.equal(claudeRuntime.deleteSessionHistory(rootId, context), true);
  assert.equal(claudeRuntime.deleteSessionHistory('../bad', context), false);
});

test('batch project deletion removes both runtimes, duplicate files, and child trees with different cwd', async (t) => {
  const root = fixture(t);
  const homes = [path.join(root, 'codex-one'), path.join(root, 'codex-two')];
  const cwd = path.join(root, 'repo');
  const secondCwd = path.join(root, 'second-repo');
  const otherCwd = path.join(root, 'other');
  const projectsRoot = path.join(root, 'claude');
  const projectHash = projectHashFromCwd(cwd, projectsRoot);
  const secondHash = projectHashFromCwd(secondCwd, projectsRoot);
  writeClaude(projectsRoot, projectHash, rootId);
  writeClaude(projectsRoot, `${projectHash}--claude-worktrees-feature`, childId);
  const secondClaude = writeClaude(projectsRoot, secondHash, nestedId);
  const removed = [
    writeCodex(homes[0], cwd, rootId),
    writeCodex(homes[1], cwd, rootId),
    writeCodex(homes[0], otherCwd, childId, rootId),
    writeCodex(homes[1], otherCwd, nestedId, childId),
  ];
  removed.push(secondClaude, writeCodex(homes[1], secondCwd, '55555555-5555-4555-8555-555555555555'));
  const keep = writeCodex(homes[0], otherCwd, otherId);
  const watermarks = new Map([[`codex:${rootId}`, 1], [`codex:${childId}`, 1], [`codex:${otherId}`, 1]]);
  const context = { projectsRoot, claudeProjectsRoot: projectsRoot, codexHomes: homes, watermarks, runningInfo };
  const result = await deleteHistoryFiles({ projectHashes: [projectHash, secondHash] }, context);
  assert.equal(result.ok, true);
  assert.equal(result.deletedProjects, 2);
  for (const file of removed) assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(keep), true);
  assert.deepEqual(discoverCodexSessions(context).sessions.map((s) => s.id), [otherId]);
  assert.equal(discoverClaudeSessions({ claudeProjectsRoot: projectsRoot, runningInfo, daemonMeta: new Map() }).sessions.length, 0);
  assert.deepEqual([...watermarks.keys()].filter((id) => id.startsWith('codex:')), [`codex:${otherId}`]);
});

test('Codex discovery supports large headers without reading huge bodies and tolerates bad files', async (t) => {
  const root = fixture(t);
  const large = writeCodex(root, '/repo', rootId);
  fs.truncateSync(large, 128 * 1024 * 1024);
  const bad = writeCodex(root, '/other', otherId);
  fs.writeFileSync(bad, 'not JSON\n');
  const archived = writeCodex(root, '/archive', childId);
  const archivePath = archived.replace(`${path.sep}sessions${path.sep}`, `${path.sep}archived_sessions${path.sep}`);
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.renameSync(archived, archivePath);
  const largeHeader = writeCodex(root, '/repo', nestedId);
  fs.writeFileSync(largeHeader, JSON.stringify({
    type: 'session_meta',
    payload: { id: nestedId, base_instructions: 'x'.repeat(200_000), cwd: '/repo', parent_thread_id: rootId },
  }) + '\n');
  const originalRead = fs.read;
  let bytes = 0;
  fs.read = function (fd, buffer, offset, length, position, callback) {
    return originalRead.call(this, fd, buffer, offset, length, position, (error, size, ...rest) => {
      bytes += size || 0;
      callback(error, size, ...rest);
    });
  };
  let history;
  try { history = await discoverCodexHistory({ codexHomes: [root] }); }
  finally { fs.read = originalRead; }
  assert.ok(bytes < 256 * 1024, `Read ${bytes} bytes instead of just the headers`);
  assert.equal(history.find((file) => file.id === rootId).cwd, '/repo');
  assert.equal(history.find((file) => file.id === otherId).cwd, undefined);
  assert.equal(history.find((file) => file.id === childId).filePath, archivePath);
  assert.equal(history.find((file) => file.id === nestedId).parentId, rootId);
  const result = await deleteHistoryFiles({ projectHashes: ['-repo'] }, { codexHomes: [root] });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(large), false);
  assert.equal(fs.existsSync(largeHeader), false);
  assert.equal(fs.existsSync(bad), true);
});

test('Codex session deletion uses the native client, includes archives, preserves forks, and is retryable', async (t) => {
  const home = fixture(t);
  const parent = writeCodex(home, '/repo', rootId);
  const child = writeCodex(home, '/other', childId, rootId);
  const fork = writeCodex(home, '/fork', otherId);
  const forkRows = fs.readFileSync(fork, 'utf8').replace('"cwd":"/fork"', `"cwd":"/fork","forked_from_id":"${rootId}"`);
  fs.writeFileSync(fork, forkRows);
  const archived = parent.replace(`${path.sep}sessions${path.sep}`, `${path.sep}archived_sessions${path.sep}`);
  fs.mkdirSync(path.dirname(archived), { recursive: true });
  fs.copyFileSync(parent, archived);
  const requests = [];
  let created = 0;
  let stopped = 0;
  const result = await deleteHistoryFiles({ sessionIds: [`codex:${rootId}`] }, {
    codexHomes: [home],
    createCodexClient(options) {
      created++;
      assert.equal(options.env.CODEX_HOME, home);
      return {
        request: async (method, params) => { requests.push([method, params]); },
        stop: async () => { stopped++; },
      };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(created, 1);
  assert.equal(stopped, 1);
  assert.deepEqual(requests.map(([method, params]) => [method, params.threadId]).sort(), [
    ['thread/delete', rootId], ['thread/delete', childId],
  ].sort());
  for (const file of [parent, archived, child]) assert.equal(fs.existsSync(file), false);
  assert.equal((await deleteHistoryFiles({ sessionIds: [`codex:${rootId}`] }, { codexHomes: [home] })).ok, true);
  assert.equal(fs.existsSync(fork), true);
});

test('Codex cleans state-only threads through the official API and falls back when startup fails', async (t) => {
  const home = fixture(t);
  const requests = [];
  const result = await deleteHistoryFiles({ sessionIds: [`codex:${rootId}`] }, {
    codexHomes: [home],
    createCodexClient: () => ({
      request: async (...args) => { requests.push(args); },
      stop: async () => {},
    }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(requests, [['thread/delete', { threadId: rootId }]]);
  const file = writeCodex(home, '/repo', rootId);
  const fallback = await deleteHistoryFiles({ sessionIds: [`codex:${rootId}`] }, {
    codexHomes: [home],
    createCodexClient: () => ({
      start: async () => { throw new Error('app-server unavailable'); },
      request: async () => assert.fail('Failed startup must not issue requests'),
      stop: async () => {},
    }),
  });
  assert.equal(fallback.ok, false);
  assert.match(fallback.error, /database deletion was not confirmed/);
  assert.equal(fs.existsSync(file), false);
});

test('Codex reports actual removal failures but continues deleting other files', async (t) => {
  const home = fixture(t);
  const blocked = writeCodex(home, '/repo', rootId);
  const removable = writeCodex(home, '/repo', otherId);
  const result = await deleteHistoryFiles({ projectHashes: ['-repo'] }, {
    codexHomes: [home],
    createCodexClient: () => ({
      request: async (_method, { threadId }) => {
        if (threadId === rootId) {
          fs.unlinkSync(blocked);
          fs.mkdirSync(blocked);
        }
      },
      stop: async () => {},
    }),
  });
  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.equal(fs.existsSync(removable), false);
});

test('Codex matches Windows hashes and deleted Claude worktrees without their directories', async (t) => {
  const home = fixture(t);
  const main = path.join(home, 'repo');
  const worktree = path.join(main, '.claude', 'worktrees', 'removed');
  for (const [cwd, projectHash] of [
    ['C:\\repo', 'C-repo'], ['C:\\repo', 'C--repo'], [worktree, projectHashFromCwd(main)],
  ]) {
    const file = writeCodex(home, cwd, rootId);
    assert.equal(fs.existsSync(cwd), false);
    const result = await deleteHistoryFiles({ projectHashes: [projectHash] }, { codexHomes: [home] });
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(file), false);
  }
});

test('a disconnected Codex client does not incur a timeout for each remaining batch', async (t) => {
  const home = fixture(t);
  const files = [];
  for (let i = 0; i < 20; i++) {
    files.push(writeCodex(home, '/repo', `55555555-5555-4555-8555-${String(i).padStart(12, '0')}`));
  }
  let requests = 0;
  const result = await deleteHistoryFiles({ projectHashes: ['-repo'] }, {
    codexHomes: [home],
    createCodexClient: () => ({
      request: async () => { requests++; throw new Error('thread/delete timed out'); },
      stop: async () => {},
    }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /database deletion was not confirmed/);
  assert.ok(requests <= 8);
  assert.ok(files.every((file) => !fs.existsSync(file)));
});

test('owned sessions block both session and project deletion before removing files', async (t) => {
  for (const runtime of [claudeRuntime, codexRuntime]) {
    const root = fixture(t);
    const file = runtime.runtime === 'claude'
      ? writeClaude(root, '-repo', rootId)
      : writeCodex(root, '/repo', rootId);
    const adapter = { ...runtime, ownsLiveSession: (id) => id === rootId };
    for (const request of [{ sessionIds: [runtime.runtime === 'codex' ? `codex:${rootId}` : rootId] }, { projectHashes: ['-repo'] }]) {
      const result = await deleteHistoryFiles(request, { projectsRoot: root, codexHomes: [root] }, [adapter]);
      assert.equal(result.ok, false);
      assert.match(result.error, /active/);
      assert.equal(fs.existsSync(file), true);
    }
  }
});

test('Claude scans its project directory once when deleting a session batch', async (t) => {
  const root = fixture(t);
  writeClaude(root, '-repo', rootId);
  writeClaude(root, '-repo', childId);
  const original = fs.readdirSync;
  let reads = 0;
  fs.readdirSync = function (dir, ...args) {
    if (dir === root) reads++;
    return original.call(this, dir, ...args);
  };
  try {
    assert.equal((await deleteHistoryFiles({ sessionIds: [rootId, childId] }, { projectsRoot: root }, [claudeRuntime])).ok, true);
  } finally { fs.readdirSync = original; }
  assert.equal(reads, 1);
});

test('unexpected dispatch failures still stop native clients and send a final response', async () => {
  const context = {};
  const sent = [];
  let stopped = false;
  const adapter = {
    runtime: 'codex', features: { deleteHistory: true },
    async deleteSessionHistory() {
      context.codexDeleteClients.set('home', { client: { stop: async () => { stopped = true; } } });
      return true;
    },
  };
  await handleDeleteFiles({
    sessionIds: [`codex:${rootId}`, { toString() { throw new Error('invalid ID'); } }],
  }, { context, adapters: [adapter], send: (result) => sent.push(result) });
  assert.equal(stopped, true);
  assert.equal(sent.at(-1).ok, false);
  assert.match(sent.at(-1).error, /invalid ID/);
  const unknown = await deleteHistoryFiles({ sessionIds: [rootId] }, {}, []);
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /Unknown session runtime/);
});

test('a native refusal does not fall back to unlinking a potentially active thread', async (t) => {
  const home = fixture(t);
  const file = writeCodex(home, '/repo', rootId);
  const result = await deleteHistoryFiles({ sessionIds: [`codex:${rootId}`] }, {
    codexHomes: [home],
    createCodexClient: () => ({
      request: async () => { throw Object.assign(new Error('Thread has an active turn'), { code: -32600 }); },
      stop: async () => {},
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(fs.existsSync(file), true);
});
