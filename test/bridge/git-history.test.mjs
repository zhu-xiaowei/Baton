import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { handleGitStatusMessage } from '../../bridge/project/git.mjs';
import { clearGitContextCache } from '../../bridge/project/git-context.mjs';
import { clearDiffCache } from '../../bridge/project/git-diff.mjs';

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function write(root, file, text) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}

function commit(root, message) {
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', message]);
}

// main: root → base → merge(feature) → tip; feature: one commit that renames a file.
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpeek-history-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'user.email', 'test@example.com']);
  write(root, 'app/old.txt', 'one\n');
  write(root, 'other/sibling.txt', 'one\n');
  commit(root, 'root');
  write(root, 'app/base.txt', 'base\n');
  commit(root, 'base');
  git(root, ['switch', '-qc', 'feature']);
  git(root, ['mv', 'app/old.txt', 'app/new.txt']);
  commit(root, 'rename in feature');
  git(root, ['switch', '-q', 'main']);
  write(root, 'other/sibling.txt', 'two\n');
  commit(root, 'sibling only');
  git(root, ['merge', '-q', '--no-ff', '-m', 'merge feature', 'feature']);
  write(root, 'app/base.txt', 'tip\n');
  commit(root, 'tip');
  return root;
}

async function call(root, operation, fields = {}) {
  const sent = [];
  await handleGitStatusMessage({
    action: 'git_status',
    operation,
    requestId: '550e8400-e29b-41d4-a716-446655440000',
    projectHash: 'fixture',
    ...fields,
  }, { resolveProjectPath: () => root, send: (message) => sent.push(message) });
  const frames = sent.sort((left, right) => left.sequence - right.sequence);
  const field = { refs: 'refs', history: 'commits', commit_files: 'files' }[operation];
  return { ...frames.at(-1), ...(field ? { [field]: frames.flatMap((frame) => frame[field] || []) } : {}) };
}

test.beforeEach(() => {
  clearGitContextCache();
  clearDiffCache();
});

test('history pages through fixed heads in topo order with parents, refs and stats', async () => {
  const root = repo();
  try {
    const expected = git(root, ['log', '--topo-order', '--format=%s', '--branches']).trim().split('\n');
    const first = await call(root, 'history', { scope: 'all', limit: 3 });
    assert.equal(first.ok, true);
    assert.equal(first.hasMore, true);
    assert.deepEqual(first.commits.map((item) => item.subject), expected.slice(0, 3));
    assert.deepEqual(first.commits[0].refs, [{ name: 'main', kind: 'local', head: true }]);
    assert.equal(first.commits[1].parents.length, 2);
    assert.deepEqual(first.commits[0].stats, { files: 1, insertions: 1, deletions: 1 });
    write(root, 'late.txt', 'late\n');
    commit(root, 'added while paging');
    const second = await call(root, 'history', { scope: 'all', heads: first.heads, skip: 3, limit: 3 });
    assert.deepEqual(second.commits.map((item) => item.subject), expected.slice(3));
    assert.equal(second.hasMore, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('commit files and diff compare a merge with its first parent and a root with the empty tree', async () => {
  const root = repo();
  try {
    const all = (await call(root, 'history', { scope: 'all', limit: 20 })).commits;
    const merge = all.find((item) => item.subject === 'merge feature');
    const files = await call(root, 'commit_files', { commitOid: merge.oid });
    assert.equal(files.merge, true);
    assert.deepEqual(files.files, [{ path: 'app/new.txt', previousPath: 'app/old.txt', status: 'renamed' }]);
    const diff = await call(root, 'diff', { commitOid: merge.oid, path: 'app/new.txt' });
    assert.match(diff.content, /rename from app\/old\.txt/);
    const rootCommit = all.find((item) => item.subject === 'root');
    const rootFiles = await call(root, 'commit_files', { commitOid: rootCommit.oid });
    assert.equal(rootFiles.baseOid, '');
    assert.deepEqual(rootFiles.files.map((item) => item.status), ['added', 'added']);
    const missing = await call(root, 'diff', { commitOid: merge.oid, path: 'other/sibling.txt' });
    assert.equal(missing.errorCode, 'target_changed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a subdirectory project only sees its own history, files and project-relative paths', async () => {
  const root = repo();
  try {
    const app = path.join(root, 'app');
    const history = await call(app, 'history', { scope: 'auto', limit: 20 });
    assert.ok(!history.commits.some((item) => item.subject === 'sibling only'));
    const tip = history.commits[0];
    const files = await call(app, 'commit_files', { commitOid: tip.oid });
    assert.deepEqual(files.files, [{ path: 'base.txt', status: 'modified' }]);
    const diff = await call(app, 'diff', { commitOid: tip.oid, path: 'base.txt' });
    assert.match(diff.content, /^diff --git a\/base\.txt b\/base\.txt/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('commit only accepts the staged set the user saw and returns the new head', async () => {
  const root = repo();
  try {
    write(root, 'app/base.txt', 'staged\n');
    git(root, ['add', 'app/base.txt']);
    const status = await call(root, 'status');
    assert.deepEqual(status.capabilities, { history: 1, commit: 1, push: 1 });
    write(root, 'app/extra.txt', 'extra\n');
    git(root, ['add', 'app/extra.txt']);
    const stale = await call(root, 'commit', { message: 'stale', stagedId: status.stagedId });
    assert.equal(stale.errorCode, 'target_changed');
    assert.equal(stale.groups.staged.length, 2);
    const done = await call(root, 'commit', { message: '  feat: two files\n\nbody  ', stagedId: stale.stagedId });
    assert.equal(done.ok, true);
    assert.equal(done.commit.subject, 'feat: two files');
    assert.equal(done.commit.oid, git(root, ['rev-parse', 'HEAD']).trim());
    assert.equal(git(root, ['log', '-1', '--format=%B']).trim(), 'feat: two files\n\nbody');
    assert.equal(done.groups.staged.length, 0);
    const empty = await call(root, 'commit', { message: 'nothing', stagedId: done.stagedId });
    assert.equal(empty.errorCode, 'nothing_staged');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('commit from a subdirectory project refuses staged files outside the project', async () => {
  const root = repo();
  try {
    write(root, 'app/base.txt', 'inside\n');
    write(root, 'other/sibling.txt', 'outside\n');
    git(root, ['add', '-A']);
    const status = await call(path.join(root, 'app'), 'status');
    const result = await call(path.join(root, 'app'), 'commit', { message: 'scoped', stagedId: status.stagedId });
    assert.equal(result.errorCode, 'outside_staged');
    assert.equal(git(root, ['log', '-1', '--format=%s']).trim(), 'tip');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('push publishes, pushes to the upstream and reports a rejected remote without forcing', async () => {
  const root = repo();
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpeek-remote-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpeek-other-'));
  try {
    git(remote, ['init', '-q', '--bare']);
    git(root, ['remote', 'add', 'origin', remote]);
    const published = await call(root, 'push');
    assert.equal(published.ok, true);
    assert.deepEqual(published.push, { remote: 'origin', branch: 'main', published: true });
    assert.equal(published.repository.upstream, 'origin/main');
    write(root, 'app/base.txt', 'ahead\n');
    commit(root, 'ahead');
    assert.equal((await call(root, 'status')).repository.ahead, 1);
    const pushed = await call(root, 'push');
    assert.equal(pushed.push.published, false);
    assert.equal(pushed.repository.ahead, 0);
    assert.equal(git(remote, ['rev-parse', 'main']).trim(), git(root, ['rev-parse', 'HEAD']).trim());
    execFileSync('git', ['clone', '-q', remote, other]);
    git(other, ['config', 'user.name', 'Other']);
    git(other, ['config', 'user.email', 'other@example.com']);
    write(other, 'remote.txt', 'remote\n');
    commit(other, 'remote only');
    git(other, ['push', '-q', 'origin', 'main']);
    write(root, 'local.txt', 'local\n');
    commit(root, 'local only');
    const rejected = await call(root, 'push');
    assert.equal(rejected.errorCode, 'push_rejected');
    assert.equal(git(remote, ['log', '-1', '--format=%s', 'main']).trim(), 'remote only');
  } finally {
    [root, remote, other].forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  }
});
