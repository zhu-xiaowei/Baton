import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import {
  parseStorageSessionId,
  projectHashCandidatesFromCwd,
  projectHashFromCwd,
  storageSessionId,
} from '../../bridge/session-identity.mjs';
import { resolveCodexHomes } from '../../bridge/runtime-capabilities.mjs';
import { detectRegisteredRuntimeCapabilities } from '../../bridge/runtime-registry.mjs';

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpeek-projects-'));
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

test('runtime capabilities distinguish installed binaries from history', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpeek-runtime-'));
  const claudeProjects = path.join(root, 'claude-projects');
  const codexHome = path.join(root, 'codex');
  fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
  try {
    const capabilities = detectRegisteredRuntimeCapabilities({
      claude: {
        claudeProjects,
        claudeBin: null,
        skipVersions: true,
      },
      codex: {
        codexHomes: [codexHome],
        codexBin: '/fake/codex',
        skipVersions: true,
      },
    });
    assert.equal(capabilities.claude.installed, false);
    assert.equal(capabilities.claude.historyAvailable, false);
    assert.equal(capabilities.codex.installed, true);
    assert.equal(capabilities.codex.historyAvailable, true);
    assert.equal(capabilities.codex.canRead, true);
    assert.equal(capabilities.codex.canCreate, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
