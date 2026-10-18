import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { handleGitStatusMessage } from '../../bridge/project/git.mjs';
import { clearGitContextCache } from '../../bridge/project/git-context.mjs';
import { clearDiffCache } from '../../bridge/project/git-diff.mjs';
import { snapshotFrames } from '../../bridge/project/git-status.mjs';
import { parseGitStatus } from '../../bridge/project/git-status.mjs';

const REQUEST_ID = '550e8400-e29b-41d4-a716-446655440000';

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpeek-git-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(root, 'modified.txt'), 'base\n');
  fs.writeFileSync(path.join(root, 'staged.txt'), 'base\n');
  fs.writeFileSync(path.join(root, 'both.txt'), 'base\n');
  fs.writeFileSync(path.join(root, 'deleted.txt'), 'base\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'base']);
  return root;
}

async function request(root, operation, fields = {}) {
  const sent = [];
  await handleGitStatusMessage({
    action: 'git_status',
    operation,
    requestId: REQUEST_ID,
    projectHash: 'fixture',
    ...fields,
  }, {
    resolveProjectPath: () => root,
    send: (message) => sent.push(message),
  });
  return sent;
}

function assembleSnapshot(messages) {
  assert.ok(messages.length);
  const sorted = [...messages].sort((left, right) => left.sequence - right.sequence);
  const groups = { conflicts: [], staged: [], changes: [] };
  for (const message of sorted) {
    for (const group of Object.keys(groups)) {
      groups[group].push(...(message.groups?.[group] || []));
    }
  }
  return { ...sorted.at(-1), groups };
}

test.beforeEach(() => {
  clearGitContextCache();
  clearDiffCache();
});

test('status returns grouped staged, changes, untracked and project-relative paths', async () => {
  const root = repo();
  try {
    fs.writeFileSync(path.join(root, 'modified.txt'), 'working\n');
    fs.writeFileSync(path.join(root, 'staged.txt'), 'staged\n');
    git(root, ['add', 'staged.txt']);
    fs.writeFileSync(path.join(root, 'both.txt'), 'index\n');
    git(root, ['add', 'both.txt']);
    fs.writeFileSync(path.join(root, 'both.txt'), 'working after index\n');
    fs.unlinkSync(path.join(root, 'deleted.txt'));
    fs.writeFileSync(path.join(root, 'untracked.txt'), 'new\n');

    const response = assembleSnapshot(await request(root, 'status'));
    assert.equal(response.ok, true);
    assert.equal(response.repository.branch, 'main');
    assert.match(response.snapshotId, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      response.groups.staged.map((entry) => [entry.path, entry.status]),
      [['both.txt', 'modified'], ['staged.txt', 'modified']],
    );
    assert.deepEqual(
      response.groups.changes.map((entry) => [entry.path, entry.status]),
      [
        ['both.txt', 'modified'],
        ['deleted.txt', 'deleted'],
        ['modified.txt', 'modified'],
        ['untracked.txt', 'untracked'],
      ],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('project-scoped status and stage all do not touch sibling directories', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpeek-monorepo-'));
  const app = path.join(root, 'packages', 'app');
  const sibling = path.join(root, 'packages', 'sibling');
  try {
    fs.mkdirSync(app, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.name', 'Test']);
    git(root, ['config', 'user.email', 'test@example.com']);
    fs.writeFileSync(path.join(app, 'app.txt'), 'base\n');
    fs.writeFileSync(path.join(sibling, 'sibling.txt'), 'base\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'base']);
    fs.writeFileSync(path.join(app, 'app.txt'), 'app changed\n');
    fs.writeFileSync(path.join(sibling, 'sibling.txt'), 'sibling changed\n');

    const before = assembleSnapshot(await request(app, 'status'));
    assert.deepEqual(before.groups.changes, [{
      path: 'app.txt',
      status: 'modified',
    }]);
    const after = assembleSnapshot(await request(app, 'stage', {
      group: 'changes',
      all: true,
      snapshotId: before.snapshotId,
    }));
    assert.equal(after.groups.changes.length, 0);
    assert.equal(after.groups.staged[0].path, 'app.txt');
    assert.match(git(root, ['status', '--short']), / M packages\/sibling\/sibling\.txt/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('snapshot frames stay under the WebSocket limit and reconstruct exactly', () => {
  const snapshot = {
    snapshotId: 'a'.repeat(64),
    repository: { branch: 'main', detached: false, unborn: false },
    groups: {
      conflicts: [],
      staged: Array.from({ length: 500 }, (_, index) => ({
        path: `staged/${index}-非常长的文件名.js`,
        status: 'modified',
      })),
      changes: Array.from({ length: 700 }, (_, index) => ({
        path: `changes/${index}-非常长的文件名.js`,
        status: 'untracked',
      })),
    },
  };
  const frames = snapshotFrames(snapshot, {
    action: 'git_status',
    operation: 'status',
    requestId: REQUEST_ID,
    ok: true,
  });
  assert.ok(frames.length > 1);
  assert.equal(frames.every((frame) => (
    Buffer.byteLength(JSON.stringify(frame)) <= 31_000
  )), true);
  assert.equal(assembleSnapshot(frames).groups.staged.length, 500);
  assert.equal(assembleSnapshot(frames).groups.changes.length, 700);
});

test('porcelain parser handles rename and conflicts', () => {
  const raw = Buffer.from([
    '# branch.oid abc',
    '# branch.head main',
    '2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt',
    'old name.txt',
    'u UU N... 100644 100644 100644 100644 a b c conflict.txt',
    '',
  ].join('\0'));
  const snapshot = parseGitStatus(raw, { prefix: '' });
  assert.deepEqual(snapshot.groups.staged[0], {
    path: 'new name.txt',
    previousPath: 'old name.txt',
    status: 'renamed',
  });
  assert.deepEqual(snapshot.groups.conflicts[0], {
    path: 'conflict.txt',
    status: 'conflicted',
    conflictCode: 'UU',
  });
});

test('stage, unstage and discard return the latest grouped snapshot', async () => {
  const root = repo();
  try {
    fs.writeFileSync(path.join(root, 'modified.txt'), 'working\n');
    let response = assembleSnapshot(await request(root, 'stage', {
      group: 'changes',
      path: 'modified.txt',
    }));
    assert.equal(response.groups.staged[0].path, 'modified.txt');

    response = assembleSnapshot(await request(root, 'unstage', {
      group: 'staged',
      path: 'modified.txt',
    }));
    assert.equal(response.groups.staged.length, 0);
    assert.equal(response.groups.changes[0].path, 'modified.txt');

    response = assembleSnapshot(await request(root, 'discard', {
      group: 'changes',
      path: 'modified.txt',
    }));
    assert.equal(response.groups.changes.length, 0);
    assert.equal(fs.readFileSync(path.join(root, 'modified.txt'), 'utf8'), 'base\n');

    fs.writeFileSync(path.join(root, 'untracked.txt'), 'new\n');
    response = assembleSnapshot(await request(root, 'discard', {
      group: 'changes',
      path: 'untracked.txt',
    }));
    assert.equal(response.groups.changes.length, 0);
    assert.equal(fs.existsSync(path.join(root, 'untracked.txt')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('all mutation rejects a stale snapshot and returns the current snapshot', async () => {
  const root = repo();
  try {
    fs.writeFileSync(path.join(root, 'modified.txt'), 'working\n');
    const response = assembleSnapshot(await request(root, 'stage', {
      group: 'changes',
      all: true,
      snapshotId: 'stale',
    }));
    assert.equal(response.ok, false);
    assert.equal(response.errorCode, 'status_changed');
    assert.equal(response.groups.changes[0].path, 'modified.txt');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('all mutation stages, unstages and discards the complete visible section', async () => {
  const root = repo();
  try {
    fs.writeFileSync(path.join(root, 'modified.txt'), 'working\n');
    fs.writeFileSync(path.join(root, 'untracked.txt'), 'new\n');
    const before = assembleSnapshot(await request(root, 'status'));
    let after = assembleSnapshot(await request(root, 'stage', {
      group: 'changes',
      all: true,
      snapshotId: before.snapshotId,
    }));
    assert.equal(after.ok, true);
    assert.equal(after.groups.changes.length, 0);
    assert.deepEqual(
      after.groups.staged.map((entry) => entry.path),
      ['modified.txt', 'untracked.txt'],
    );

    after = assembleSnapshot(await request(root, 'unstage', {
      group: 'staged',
      all: true,
      snapshotId: after.snapshotId,
    }));
    assert.equal(after.groups.staged.length, 0);
    assert.deepEqual(
      after.groups.changes.map((entry) => entry.path),
      ['modified.txt', 'untracked.txt'],
    );

    after = assembleSnapshot(await request(root, 'discard', {
      group: 'changes',
      all: true,
      snapshotId: after.snapshotId,
    }));
    assert.equal(after.groups.changes.length, 0);
    assert.equal(fs.readFileSync(path.join(root, 'modified.txt'), 'utf8'), 'base\n');
    assert.equal(fs.existsSync(path.join(root, 'untracked.txt')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unstage works in a repository without HEAD', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpeek-unborn-'));
  try {
    git(root, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(root, 'new.txt'), 'new\n');
    git(root, ['add', 'new.txt']);
    const response = assembleSnapshot(await request(root, 'unstage', {
      group: 'staged',
      path: 'new.txt',
    }));
    assert.equal(response.ok, true);
    assert.deepEqual(response.groups.staged, []);
    assert.deepEqual(response.groups.changes, [{
      path: 'new.txt',
      status: 'untracked',
    }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('staging a conflict removes it from Merge Changes', async () => {
  const root = repo();
  try {
    git(root, ['branch', 'side']);
    fs.writeFileSync(path.join(root, 'modified.txt'), 'main\n');
    git(root, ['add', 'modified.txt']);
    git(root, ['commit', '-qm', 'main']);
    git(root, ['switch', '-q', 'side']);
    fs.writeFileSync(path.join(root, 'modified.txt'), 'side\n');
    git(root, ['add', 'modified.txt']);
    git(root, ['commit', '-qm', 'side']);
    git(root, ['switch', '-q', 'main']);
    assert.throws(() => git(root, ['merge', 'side']));

    let snapshot = assembleSnapshot(await request(root, 'status'));
    assert.equal(snapshot.groups.conflicts[0].path, 'modified.txt');
    snapshot = assembleSnapshot(await request(root, 'stage', {
      group: 'conflicts',
      path: 'modified.txt',
    }));
    assert.equal(snapshot.groups.conflicts.length, 0);
    assert.equal(snapshot.groups.staged[0].path, 'modified.txt');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('diff returns standard patches for tracked and untracked files', async () => {
  const root = repo();
  try {
    fs.writeFileSync(path.join(root, 'modified.txt'), 'working\n');
    let frames = await request(root, 'diff', {
      group: 'changes',
      path: 'modified.txt',
    });
    assert.match(frames.map((frame) => frame.content).join(''), /^diff --git/m);
    assert.equal(frames.at(-1).diffComplete, true);

    fs.writeFileSync(path.join(root, 'untracked.txt'), 'new\n');
    frames = await request(root, 'diff', {
      group: 'changes',
      path: 'untracked.txt',
    });
    const patch = frames.map((frame) => frame.content).join('');
    assert.match(patch, /^diff --git/m);
    assert.match(patch, /--- \/dev\/null/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('large diff is paged through a stable token and truncated at twenty pages', async () => {
  const root = repo();
  try {
    fs.writeFileSync(
      path.join(root, 'huge.txt'),
      'large diff line\n'.repeat(450_000),
    );
    let frames = await request(root, 'diff', {
      group: 'changes',
      path: 'huge.txt',
    });
    assert.equal(frames.every((frame) => (
      Buffer.byteLength(JSON.stringify(frame)) <= 31_000
    )), true);
    assert.equal(frames[0].truncated, true);
    assert.equal(frames.at(-1).diffComplete, false);
    const token = frames[0].diffToken;
    let cursor = frames.at(-1).nextCursor;
    let pages = 1;
    while (cursor) {
      frames = await request(root, 'diff', {
        group: 'changes',
        path: 'huge.txt',
        diffToken: token,
        cursor,
      });
      pages++;
      cursor = frames.at(-1).nextCursor;
    }
    assert.equal(pages, 20);
    assert.equal(frames.at(-1).diffComplete, true);
    assert.equal(frames.at(-1).truncated, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
