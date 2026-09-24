import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { projectCwdFromCwd, repositoryIdentity } from '../../bridge/repository-identity.mjs';
import { projectHashFromCwd } from '../../bridge/session-identity.mjs';
import { resolveCodexSessionCwd, scanCodexRollout } from '../../bridge/codex-session.mjs';

function fixture(context) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'baton-worktree-')));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const primary = path.join(directory, 'repo');
  const worktree = path.join(directory, 'custom-worktrees', 'repo');
  const gitDir = path.join(primary, '.git', 'worktrees', 'checkout');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.mkdirSync(path.join(primary, 'server'), { recursive: true });
  fs.mkdirSync(path.join(worktree, 'server'), { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.relative(worktree, gitDir)}\n`);
  fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(gitDir, 'gitdir'), `${path.join(worktree, '.git')}\n`);
  return { directory, primary, worktree, gitDir };
}

test('Codex repository identity groups linked checkouts but preserves relative project directories', (context) => {
  const { directory, primary, worktree } = fixture(context);
  assert.deepEqual(repositoryIdentity(worktree), repositoryIdentity(primary));
  assert.equal(projectHashFromCwd(worktree), projectHashFromCwd(primary));
  assert.equal(projectCwdFromCwd(path.join(worktree, 'server')), path.join(primary, 'server'));
  assert.equal(projectHashFromCwd(path.join(worktree, 'server')), projectHashFromCwd(path.join(primary, 'server')));
  assert.notEqual(projectHashFromCwd(path.join(worktree, 'server')), projectHashFromCwd(primary));
  const clone = path.join(directory, 'another-clone', 'repo');
  fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
  assert.notEqual(projectHashFromCwd(clone), projectHashFromCwd(primary));
});

test('invalid administrative links and missing directories are not guessed', (context) => {
  const { directory, primary, worktree, gitDir } = fixture(context);
  fs.writeFileSync(path.join(gitDir, 'gitdir'), path.join(primary, '.git'));
  assert.equal(repositoryIdentity(worktree), null);
  assert.equal(projectCwdFromCwd(worktree), worktree);
  fs.writeFileSync(path.join(gitDir, 'gitdir'), path.join(worktree, '.git'));
  fs.writeFileSync(path.join(gitDir, 'commondir'), '../../server');
  assert.equal(repositoryIdentity(worktree), null);
  assert.equal(repositoryIdentity(path.join(directory, 'missing')), null);
  assert.equal(repositoryIdentity(''), null);
});

test('symlink .git entries are not accepted as repository identity', { skip: process.platform === 'win32' }, (context) => {
  const { primary, worktree } = fixture(context);
  fs.unlinkSync(path.join(worktree, '.git'));
  fs.symlinkSync(path.join(primary, '.git'), path.join(worktree, '.git'));
  assert.equal(repositoryIdentity(worktree), null);
});

test('rollout project is canonical while existing-session commands keep the worktree cwd', (context) => {
  const { directory, primary, worktree } = fixture(context);
  const nativeSessionId = '12345678-1234-4123-8123-123456789012';
  const filePath = path.join(directory, `rollout-${nativeSessionId}.jsonl`);
  fs.writeFileSync(filePath, [
    { type: 'session_meta', payload: { id: nativeSessionId, cwd: worktree } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Hello' } },
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  const session = scanCodexRollout(filePath).session;
  assert.equal(session.project, projectHashFromCwd(primary));
  assert.equal(session.cwd, worktree);
  assert.equal(resolveCodexSessionCwd(nativeSessionId, { filePath, threadName: '' }), worktree);
  fs.rmSync(worktree, { recursive: true });
  assert.throws(() => resolveCodexSessionCwd(nativeSessionId, { filePath, threadName: '' }), /working directory is unavailable/);
});
