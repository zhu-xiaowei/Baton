import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import {
  normalizeRuntime,
  parseStorageSessionId,
  projectHashCandidatesFromCwd,
  projectHashFromCwd,
  registerRuntimeDescriptor,
  storageSessionId,
} from '../../bridge/session-identity.mjs';
import { resolveCodexHomes } from '../../bridge/runtime-capabilities.mjs';

test('storage ids preserve Claude and prefix Codex exactly once', () => {
  assert.equal(storageSessionId('claude', 'same-id'), 'same-id');
  assert.equal(storageSessionId('codex', 'same-id'), 'codex:same-id');
  assert.equal(storageSessionId('codex', 'codex:same-id'), 'codex:same-id');
  assert.deepEqual(parseStorageSessionId('codex:same-id'), {
    runtime: 'codex',
    nativeSessionId: 'same-id',
    sessionId: 'codex:same-id',
  });
  assert.deepEqual(parseStorageSessionId('same-id'), {
    runtime: 'claude',
    nativeSessionId: 'same-id',
    sessionId: 'same-id',
  });
});

test('registered runtimes get their own prefix and unknown ones are never claude', () => {
  registerRuntimeDescriptor({ runtime: 'rt1' });
  assert.equal(storageSessionId('rt1', 'x'), 'rt1:x');
  assert.deepEqual(parseStorageSessionId('rt1:x'), { runtime: 'rt1', nativeSessionId: 'x', sessionId: 'rt1:x' });
  assert.equal(normalizeRuntime('nope'), null);
});

test('POSIX path hashing matches existing Claude format and collapses worktrees', () => {
  assert.equal(projectHashFromCwd('/Users/demo/work/my_repo.v2'), '-Users-demo-work-my-repo-v2');
  assert.equal(
    projectHashFromCwd('/Users/demo/repo/.claude/worktrees/feature'),
    '-Users-demo-repo',
  );
});

test('Windows path candidates cover canonical and literal drive separators', () => {
  assert.deepEqual(projectHashCandidatesFromCwd('c:\\Users\\Admin\\repo'), [
    'C-Users-Admin-repo',
    'C--Users-Admin-repo',
  ]);
});

test('an existing Claude Windows hash wins over the canonical candidate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-projects-'));
  try {
    fs.mkdirSync(path.join(root, 'C--Users-Admin-repo'));
    assert.equal(projectHashFromCwd('C:\\Users\\Admin\\repo', root), 'C--Users-Admin-repo');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex homes prefer explicit CODEX_HOME and dedupe defaults', () => {
  const homes = resolveCodexHomes({ CODEX_HOME: path.join(os.homedir(), '.codex') });
  assert.deepEqual(homes, [path.join(os.homedir(), '.codex')]);
});

test('Codex homes ignore legacy WSL profile discovery', () => {
  const homes = resolveCodexHomes({
    WSL_DISTRO_NAME: 'Ubuntu',
    USERPROFILE: 'C:\\Users\\Admin',
  });
  assert.deepEqual(homes, [path.join(os.homedir(), '.codex')]);
});
