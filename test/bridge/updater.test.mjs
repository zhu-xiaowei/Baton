import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import { installStagedBridge } from '../../bridge/updater.mjs';

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
