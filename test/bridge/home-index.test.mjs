import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HomeIndex } from '../../bridge/home-index.mjs';
import { ObservedMap } from '../../bridge/observed-map.mjs';
import { projectHashFromCwd } from '../../bridge/session-identity.mjs';

const BASE = Date.parse('2026-11-01T00:00:00Z');
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-home-index-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const claudeRoot = path.join(root, '.claude', 'projects');
  const codexHome = path.join(root, '.codex');
  fs.mkdirSync(claudeRoot, { recursive: true });
  const statuses = new ObservedMap();
  const index = new HomeIndex({ statuses, claudeRoot, codexHomes: [codexHome] });
  statuses.onChange = () => index.markDirty();
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
  const home = index.home();
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
  const first = index.home();
  assert.equal(first.sessions.length, 0);
  assert.deepEqual(index.home(first.revision), { revision: first.revision, notModified: true });
  statuses.set(id(1), 'running');
  statuses.set(id(2), 'needs_input');
  const second = index.home(first.revision);
  assert.notEqual(second.revision, first.revision);
  assert.deepEqual(second.sessions.map((s) => [s.sessionId, s.status]), [[id(1), 'running']]);
  assert.equal(second.device.runningCount, 1);
  assert.equal(second.device.needsInputCount, 1, 'an old needs_input still counts but is not listed');
  assert.ok(old);
});

test('watcher notes update order and previews without re-reading the file', async (t) => {
  const { claudeRoot, index } = fixture(t);
  claude(claudeRoot, '-a', 1, 1);
  const file = claude(claudeRoot, '-b', 2, 0);
  await index.warm();
  assert.equal(index.home().recentProjects[0].projectHash, '-a');
  fs.appendFileSync(file, JSON.stringify({ type: 'assistant', message: { content: 'ok' } }) + '\n');
  index.noteClaude(file, { preview: 'Renamed title' });
  const home = index.home();
  assert.equal(home.recentProjects[0].projectHash, '-b');
  assert.equal(home.recentProjects[0].sessions[0].preview, 'Renamed title');
});

test('Codex child threads are counted on their root and never listed', async (t) => {
  const { claudeRoot, codexHome, index } = fixture(t);
  codex(codexHome, '/repo', 1, 1);
  codex(codexHome, '/repo', 2, 2, id(1));
  await index.warm();
  const project = index.home().recentProjects[0];
  assert.equal(project.projectHash, projectHashFromCwd('/repo', claudeRoot));
  assert.deepEqual(project.sessions.map((s) => [s.sessionId, s.agentCount]), [[`codex:${id(1)}`, 1]]);
});
