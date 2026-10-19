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
import { discoverCodexSessions } from '../../bridge/codex-session.mjs';
import { handleDeleteFiles } from '../../bridge/ws.mjs';
import { projectHashFromCwd } from '../../bridge/session-identity.mjs';

const rootId = '11111111-1111-4111-8111-111111111111';
const childId = '22222222-2222-4222-8222-222222222222';
const nestedId = '33333333-3333-4333-8333-333333333333';
const otherId = '44444444-4444-4444-8444-444444444444';
const runningInfo = { projects: new Set(), sessions: new Set() };

function deleteHistoryFiles(request, context, adapters) {
  let sent;
  handleDeleteFiles(request, { context, adapters, send: (result) => { sent = result; } });
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

test('Claude session deletion removes all copies and nested agents, and is retryable', (t) => {
  const projectsRoot = fixture(t);
  const first = writeClaude(projectsRoot, '-repo', rootId);
  const second = writeClaude(projectsRoot, '-repo--claude-worktrees-feature', rootId);
  const keep = writeClaude(projectsRoot, '-repo', otherId);
  const child = path.join(projectsRoot, '-repo', rootId, 'subagents', 'agent-child.jsonl');
  fs.mkdirSync(path.dirname(child), { recursive: true });
  fs.writeFileSync(child, '{}\n');
  const watermarks = new Map([[rootId, 1], [`${rootId}:subagent:agent-child`, 1], [otherId, 1]]);
  const context = { projectsRoot, watermarks };
  assert.equal(claudeRuntime.deleteSessionHistory(rootId, context), true);
  for (const file of [first, second, child]) assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(keep), true);
  assert.deepEqual([...watermarks.keys()], [otherId]);
  assert.equal(claudeRuntime.deleteSessionHistory(rootId, context), true);
  assert.equal(claudeRuntime.deleteSessionHistory('../bad', context), false);
});

test('batch project deletion removes both runtimes, duplicate files, and child trees with different cwd', (t) => {
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
  // This child has no prompt; its title can be provided by the separate index.
  const childRows = fs.readFileSync(removed[2], 'utf8').trim().split('\n');
  fs.writeFileSync(removed[2], childRows[0] + '\n');
  removed.push(secondClaude, writeCodex(homes[1], secondCwd, '55555555-5555-4555-8555-555555555555'));
  const keep = writeCodex(homes[0], otherCwd, otherId);
  const watermarks = new Map([[`codex:${rootId}`, 1], [`codex:${childId}`, 1], [`codex:${otherId}`, 1]]);
  const context = { projectsRoot, claudeProjectsRoot: projectsRoot, codexHomes: homes, watermarks, runningInfo };
  const result = deleteHistoryFiles({ projectHashes: [projectHash, secondHash] }, context);
  assert.equal(result.ok, true);
  assert.equal(result.deletedProjects, 2);
  for (const file of removed) assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(keep), true);
  assert.deepEqual(discoverCodexSessions(context).sessions.map((s) => s.id), [otherId]);
  assert.equal(discoverClaudeSessions({ claudeProjectsRoot: projectsRoot, runningInfo, daemonMeta: new Map() }).sessions.length, 0);
  assert.deepEqual([...watermarks.keys()].filter((id) => id.startsWith('codex:')), [`codex:${otherId}`]);
});

test('Codex session deletion supports repeated requests without deleting sibling sessions', (t) => {
  const root = fixture(t);
  const context = { codexHomes: [root], runningInfo };
  const file = writeCodex(root, '/repo', rootId);
  const keep = writeCodex(root, '/repo', otherId);
  for (let i = 0; i < 2; i++) {
    const result = deleteHistoryFiles({ sessionIds: [`codex:${rootId}`] }, { ...context });
    assert.equal(result.ok, true);
  }
  assert.equal(codexRuntime.features.deleteHistory, true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(keep), true);
});

test('file deletion reports unsupported runtimes, false returns, and exceptions', () => {
  const adapters = [
    { ...claudeRuntime, deleteProjectHistory: () => false, deleteSessionHistory: () => { throw new Error('permission denied'); } },
    { ...codexRuntime, features: { deleteHistory: false } },
  ];
  const result = deleteHistoryFiles({ projectHashes: ['-repo'], sessionIds: [rootId] }, {}, adapters);
  assert.equal(result.ok, false);
  assert.equal(result.deletedProjects, 0);
  assert.equal(result.deletedSessions, 0);
  assert.equal(result.errors.length, 2);
  assert.equal(result.skippedReadOnly, 1);
  assert.match(result.error, /permission denied/);
  assert.match(result.error, /could not be deleted/);
});
