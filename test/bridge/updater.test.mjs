import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import {
  cleanupUpdateWorkspace,
  createUpdateWorkspace,
  installStagedBridge,
} from '../../bridge/updater.mjs';
import {
  findExecutable,
  installProductionDependencies,
  runExecutable,
} from '../../bridge/platform.mjs';

test('update workspace is created outside the Bridge home', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-update-workspace-'));
  const home = path.join(root, 'home', '.baton-bridge');
  const tempRoot = path.join(root, 'tmp');
  fs.mkdirSync(home, { recursive: true });
  const workspace = createUpdateWorkspace(home, tempRoot);

  try {
    assert.equal(path.relative(home, workspace.root).startsWith('..'), true);
    assert.equal(path.dirname(workspace.root), tempRoot);
    assert.equal(fs.existsSync(workspace.stage), true);
  } finally {
    cleanupUpdateWorkspace(workspace);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('update workspace rejects a temporary root inside the Bridge home', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-update-workspace-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  try {
    assert.throws(
      () => createUpdateWorkspace(home, path.join(home, 'tmp')),
      /must be outside/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('isolated update validation cannot load a native package from the current Bridge home', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-update-native-'));
  const home = path.join(root, 'home', '.baton-bridge');
  const tempRoot = path.join(root, 'tmp');
  const nativePackage = path.join(home, 'node_modules', 'fixture-native');
  fs.mkdirSync(nativePackage, { recursive: true });
  fs.writeFileSync(path.join(nativePackage, 'package.json'), JSON.stringify({
    name: 'fixture-native',
    version: '1.0.0',
    main: 'index.js',
  }));
  fs.writeFileSync(path.join(nativePackage, 'index.js'), 'module.exports = true;');
  const dependency = path.join(root, 'fixture-dependency');
  fs.mkdirSync(dependency);
  fs.writeFileSync(path.join(dependency, 'package.json'), JSON.stringify({
    name: 'fixture-dependency',
    version: '1.0.0',
    main: 'index.js',
  }));
  fs.writeFileSync(
    path.join(dependency, 'index.js'),
    "module.exports = require('fixture-native');",
  );
  const npm = findExecutable('npm');
  const archive = runExecutable(npm, ['pack', '--silent'], {
    cwd: dependency,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const workspace = createUpdateWorkspace(home, tempRoot);
  fs.writeFileSync(path.join(workspace.stage, 'package.json'), JSON.stringify({
    name: 'staged-bridge',
    version: '1.0.0',
    dependencies: {
      'fixture-dependency': `file:${path.join(dependency, archive)}`,
    },
  }));
  fs.copyFileSync(
    new URL('../../bridge/verify-dependencies.mjs', import.meta.url),
    path.join(workspace.stage, 'verify-dependencies.mjs'),
  );
  runExecutable(npm, [
    'install',
    '--package-lock-only',
    '--ignore-scripts',
    '--silent',
    '--no-audit',
    '--no-fund',
  ], { cwd: workspace.stage, stdio: 'ignore' });

  try {
    assert.throws(() => installProductionDependencies(workspace.stage));
  } finally {
    cleanupUpdateWorkspace(workspace);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('staged update replaces package files and dependencies but preserves user state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-update-'));
  const home = path.join(root, 'home');
  const stage = path.join(root, 'stage');
  fs.mkdirSync(path.join(home, 'node_modules', 'old-dep'), { recursive: true });
  fs.mkdirSync(path.join(stage, 'node_modules', 'new-dep'), { recursive: true });
  fs.writeFileSync(path.join(home, 'bridge.mjs'), 'old bridge');
  fs.writeFileSync(path.join(home, 'config.json'), '{"deviceName":"Mac"}');
  fs.writeFileSync(path.join(home, 'node_modules', 'old-dep', 'index.js'), 'old');
  fs.writeFileSync(path.join(stage, 'bridge.mjs'), 'new bridge');
  fs.writeFileSync(path.join(stage, 'codex-session.mjs'), 'new module');
  fs.writeFileSync(path.join(stage, 'package.json'), '{"name":"bridge"}');
  fs.writeFileSync(path.join(stage, 'package-lock.json'), '{"name":"bridge","lockfileVersion":3}');
  fs.writeFileSync(path.join(stage, 'node_modules', 'new-dep', 'index.js'), 'new');

  try {
    installStagedBridge(stage, home);
    assert.equal(fs.readFileSync(path.join(home, 'bridge.mjs'), 'utf-8'), 'new bridge');
    assert.equal(fs.readFileSync(path.join(home, 'codex-session.mjs'), 'utf-8'), 'new module');
    assert.equal(
      fs.readFileSync(path.join(home, 'package-lock.json'), 'utf-8'),
      '{"name":"bridge","lockfileVersion":3}',
    );
    assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf-8'), '{"deviceName":"Mac"}');
    assert.equal(fs.readFileSync(path.join(home, 'node_modules', 'new-dep', 'index.js'), 'utf-8'), 'new');
    assert.equal(fs.existsSync(path.join(home, 'node_modules', 'old-dep')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('staged update restores dependencies when the new directory cannot be installed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-update-rollback-'));
  const home = path.join(root, 'home');
  const stage = path.join(root, 'stage');
  fs.mkdirSync(path.join(home, 'node_modules', 'old-dep'), { recursive: true });
  fs.mkdirSync(path.join(stage, 'node_modules', 'new-dep'), { recursive: true });
  fs.writeFileSync(path.join(home, 'bridge.mjs'), 'old bridge');
  fs.writeFileSync(path.join(home, 'node_modules', 'old-dep', 'index.js'), 'old');
  fs.writeFileSync(path.join(stage, 'bridge.mjs'), 'new bridge');
  fs.writeFileSync(path.join(stage, 'node_modules', 'new-dep', 'index.js'), 'new');

  const renameSync = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (path.basename(source).startsWith('.node_modules-next-')) {
      throw new Error('simulated install failure');
    }
    return renameSync(source, target);
  };

  try {
    assert.throws(() => installStagedBridge(stage, home), /simulated install failure/);
    assert.equal(fs.readFileSync(path.join(home, 'bridge.mjs'), 'utf-8'), 'old bridge');
    assert.equal(fs.readFileSync(path.join(home, 'node_modules', 'old-dep', 'index.js'), 'utf-8'), 'old');
    assert.equal(fs.existsSync(path.join(home, 'node_modules', 'new-dep')), false);
  } finally {
    fs.renameSync = renameSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
