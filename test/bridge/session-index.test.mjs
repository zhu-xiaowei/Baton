import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SessionIndex } from '../../bridge/session-index.mjs';
import { ObservedMap } from '../../bridge/observed-map.mjs';
import { projectHashFromCwd, registerRuntimeDescriptor } from '../../bridge/session-identity.mjs';

const BASE = Date.parse('2026-11-01T00:00:00Z');
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function fixture(t, { workers = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-session-index-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const claudeRoot = path.join(root, '.claude', 'projects');
  const codexHome = path.join(root, '.codex');
  fs.mkdirSync(claudeRoot, { recursive: true });
  const statuses = new ObservedMap();
  const index = new SessionIndex({ statuses, claudeRoot, codexHomes: [codexHome], workers });
  statuses.onChange = () => index.markStatus();
  return { claudeRoot, codexHome, statuses, index };
}

function claude(claudeRoot, project, n, minutes, text = `prompt ${n}`) {
  const file = path.join(claudeRoot, project, `${id(n)}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const row = text ? { type: 'user', message: { content: text } } : { type: 'system', content: 'init' };
  fs.writeFileSync(file, JSON.stringify(row) + '\n');
  const time = new Date(BASE + minutes * 60_000);
  fs.utimesSync(file, time, time);
  return file;
}

function codex(home, cwd, n, minutes, parent = '') {
  const file = path.join(home, 'sessions', '2026', '11', `rollout-${id(n)}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    { type: 'session_meta', payload: { id: id(n), cwd, ...(parent ? { parent_thread_id: parent } : {}) } },
    { type: 'event_msg', payload: { type: 'user_message', message: `codex ${n}` } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');
  const time = new Date(BASE + minutes * 60_000);
  fs.utimesSync(file, time, time);
  return file;
}

test('home lists the 15 most recent projects with their 5 newest root sessions', async (t) => {
  const { claudeRoot, index } = fixture(t);
  let n = 0;
  for (let p = 0; p < 17; p++) for (let s = 0; s < 6; s++) claude(claudeRoot, `-proj-${p}`, ++n, p * 10 + s);
  claude(claudeRoot, '-empty', ++n, 999, '');
  await index.warm();
  const home = await index.home();
  assert.equal(home.recentProjects.length, 15);
  assert.deepEqual(home.recentProjects.map((p) => p.projectHash).slice(0, 2), ['-proj-16', '-proj-15']);
  assert.deepEqual(home.recentProjects[0].sessions.map((s) => s.preview),
    ['prompt 102', 'prompt 101', 'prompt 100', 'prompt 99', 'prompt 98']);
  assert.equal(home.device.projectCount, 17);
  assert.equal(home.device.lastActive, new Date(BASE + 165 * 60_000).toISOString());
});

test('status changes, revisions and notModified', async (t) => {
  const { claudeRoot, statuses, index } = fixture(t);
  claude(claudeRoot, '-a', 1, 1);
  const old = claude(claudeRoot, '-a', 2, -60 * 24 * 8);
  await index.warm();
  const first = await index.home();
  assert.equal(first.sessions.length, 0);
  assert.deepEqual(await index.home(first.revision), { revision: first.revision, notModified: true });
  statuses.set(id(1), 'running');
  statuses.set(id(2), 'needs_input');
  const second = await index.home(first.revision);
  assert.notEqual(second.revision, first.revision);
  assert.deepEqual(second.sessions.map((s) => [s.sessionId, s.status]), [[id(1), 'running']]);
  assert.equal(second.device.runningCount, 1);
  assert.equal(second.device.needsInputCount, 1, 'an old needs_input still counts but is not listed');
  assert.ok(old);
});

test('watcher touches read only the appended lines and update order and previews', async (t) => {
  const { claudeRoot, index } = fixture(t);
  claude(claudeRoot, '-a', 1, 1);
  const file = claude(claudeRoot, '-b', 2, 0);
  await index.warm();
  assert.equal((await index.home()).recentProjects[0].projectHash, '-a');
  const offset = index.records.get(file).state.offset;
  fs.appendFileSync(file, JSON.stringify({ type: 'custom-title', customTitle: 'Renamed title' }) + '\n');
  index.touch(file);
  assert.ok(index.records.get(file).state.offset > offset);
  const home = await index.home();
  assert.equal(home.recentProjects[0].projectHash, '-b');
  assert.equal(home.recentProjects[0].sessions[0].preview, 'Renamed title');
});

test('Codex child threads are counted on their root and never listed', async (t) => {
  const { claudeRoot, codexHome, index } = fixture(t);
  codex(codexHome, '/repo', 1, 1);
  codex(codexHome, '/repo', 2, 2, id(1));
  await index.warm();
  const project = (await index.home()).recentProjects[0];
  assert.equal(project.projectHash, projectHashFromCwd('/repo', claudeRoot));
  assert.deepEqual(project.sessions.map((s) => [s.sessionId, s.agentCount]), [[`codex:${id(1)}`, 1]]);
});

test('requests wait for the warm-up', async (t) => {
  const { claudeRoot, index } = fixture(t);
  claude(claudeRoot, '-a', 1, 1);
  const early = index.home();
  await index.warm();
  assert.equal((await early).recentProjects.length, 1);
});

test('time alone ages an answer out after the recompute interval', async (t) => {
  const { claudeRoot, statuses, index } = fixture(t);
  const file = claude(claudeRoot, '-a', 1, 0);
  const now = Date.now();
  const edge = new Date(now - 7 * 86400_000 + 10_000);
  fs.utimesSync(file, edge, edge);
  statuses.set(id(1), 'needs_input');
  await index.warm();
  const first = await index.home();
  assert.equal(first.sessions.length, 1);
  t.mock.method(Date, 'now', () => now + 20_000);
  const later = await index.home(first.revision);
  assert.notEqual(later.revision, first.revision, 'no event, yet the 7-day window closed');
  assert.equal(later.sessions.length, 0);
});

const allPages = async (fn) => {
  const items = [];
  let cursor;
  do {
    const page = await fn(cursor);
    items.push(...(page.projects || page.sessions));
    cursor = page.nextCursor;
  } while (cursor);
  return items;
};

test('project and session lists page with keyset cursors and count only valid roots', async (t) => {
  const { claudeRoot, codexHome, statuses, index } = fixture(t);
  for (let s = 0; s < 7; s++) claude(claudeRoot, '-a', 10 + s, s);
  claude(claudeRoot, '-a', 30, 50, '');                       // no preview, no subagents: not a session
  for (let p = 0; p < 4; p++) claude(claudeRoot, `-p${p}`, 40 + p, 100 + p);
  codex(codexHome, '/repo', 50, 20);
  codex(codexHome, '/repo', 51, 21, id(50));
  await index.warm();
  statuses.set(id(16), 'running');
  const projects = await allPages((cursor) => index.projects({ cursor, limit: 2 }));
  assert.deepEqual(projects.map((p) => p.projectHash),
    ['-p3', '-p2', '-p1', '-p0', projectHashFromCwd('/repo', claudeRoot), '-a']);
  const a = projects.find((p) => p.projectHash === '-a');
  assert.equal(a.sessionCount, 7);
  assert.equal(a.runningCount, 1);
  const sessions = await allPages((cursor) => index.sessions({ project: '-a', cursor, limit: 3 }));
  assert.deepEqual(sessions.map((s) => s.sessionId), [16, 15, 14, 13, 12, 11, 10].map(id));
  assert.deepEqual(Object.keys(sessions[0]).sort(), ['agentCount', 'lastActive', 'model', 'preview', 'sessionId', 'size', 'status']);
  const repo = await index.sessions({ project: projectHashFromCwd('/repo', claudeRoot) });
  assert.deepEqual(repo.sessions.map((s) => [s.sessionId, s.agentCount]), [[`codex:${id(50)}`, 1]]);
  await assert.rejects(index.sessions({ project: '-a', cursor: 'nope' }), /Invalid pagination cursor/);
});

test('a session started from the App is listed before CC writes its prompt', async (t) => {
  const { claudeRoot, index } = fixture(t);
  claude(claudeRoot, '-a', 1, 1, '');
  await index.warm();
  assert.equal((await index.sessions({ project: '-a' })).sessions.length, 0);
  index.notePrompt(id(1), 'run the skill');
  assert.deepEqual((await index.sessions({ project: '-a' })).sessions.map((s) => s.preview), ['run the skill']);
});

test('one session in two project directories shows the newer, then the larger file', async (t) => {
  const { claudeRoot, index } = fixture(t);
  const stub = claude(claudeRoot, '-repo--claude-worktrees-x', 1, 5, 'stub');
  const real = claude(claudeRoot, '-repo', 1, 5, 'the real conversation');
  fs.appendFileSync(real, JSON.stringify({ type: 'assistant', message: { model: 'm', content: 'long answer' } }) + '\n');
  const time = new Date(BASE + 5 * 60_000);
  fs.utimesSync(real, time, time);
  await index.warm();
  const [session] = (await index.sessions({ project: '-repo' })).sessions;
  assert.equal(session.preview, 'the real conversation');
  const later = new Date(BASE + 6 * 60_000);
  fs.utimesSync(stub, later, later);
  index.touch(stub);
  assert.equal((await index.sessions({ project: '-repo' })).sessions[0].preview, 'stub');
});

test('worker warm-up gives the same answers as warming on this thread', async (t) => {
  const here = fixture(t);
  const workers = fixture(t, { workers: 2 });
  for (const { claudeRoot, codexHome } of [here, workers]) {
    for (let n = 0; n < 80; n++) claude(claudeRoot, `-p${n % 5}`, n + 1, n);
    for (let n = 0; n < 10; n++) codex(codexHome, '/repo', 200 + n, 100 + n);
  }
  await here.index.warm();
  await workers.index.warm();
  const strip = (answer) => ({ ...answer, revision: undefined });
  assert.deepEqual(strip(await workers.index.home()), strip(await here.index.home()));
  assert.deepEqual(await workers.index.projects(), await here.index.projects());
});

// Last: the registration stays for the rest of this file.
test('a registered rows source is listed and a change seen during its refresh is read once more', async (t) => {
  const { index } = fixture(t);
  let rows = [{ id: 'r1', ms: BASE }], calls = 0;
  registerRuntimeDescriptor({ runtime: 'rows1', catalog: { kind: 'rows', watchPaths: () => ['/db-wal'],
    refresh: async () => { calls++; return { upserts: rows }; }, status: () => 'running',
    view: (rec) => ({ project: '-p', preview: rec.id, agentCount: 0 }) } });
  await index.warm();
  rows = [{ id: 'r2', ms: BASE + 1 }];
  const refreshed = index.touch('/db-wal');
  index.touch('/db-wal');
  await refreshed;
  assert.equal(calls, 3);
  assert.deepEqual((await index.home()).sessions.map((s) => s.sessionId), ['rows1:r2', 'rows1:r1']);
});
