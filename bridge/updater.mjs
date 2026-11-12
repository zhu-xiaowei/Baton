import fs from 'fs';
import os from 'os';
import path from 'path';

function removable(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
}

export function cleanupStagedBridge(bridgeHome) {
  let entries;
  try { entries = fs.readdirSync(bridgeHome); } catch { return; }
  const prefixes = ['.update-stage-', '.update-backup-', '.node_modules-next-', '.node_modules-old-'];
  for (const entry of entries) {
    if (prefixes.some((prefix) => entry.startsWith(prefix))) {
      removable(path.join(bridgeHome, entry));
    }
  }
}

function isInside(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function createUpdateWorkspace(bridgeHome, tempRoot = os.tmpdir()) {
  if (isInside(bridgeHome, tempRoot)) {
    throw new Error('update workspace must be outside the Bridge home');
  }
  fs.mkdirSync(tempRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempRoot, 'baton-bridge-update-'));
  const stage = path.join(root, 'stage');
  fs.mkdirSync(stage);
  return {
    root,
    stage,
    archive: path.join(root, 'bridge.tar.gz'),
  };
}

export function cleanupUpdateWorkspace(workspace) {
  removable(workspace?.root);
}

export function installStagedBridge(stage, bridgeHome) {
  const token = `${process.pid}-${Date.now()}`;
  const backupDir = path.join(bridgeHome, `.update-backup-${token}`);
  const nextModules = path.join(bridgeHome, `.node_modules-next-${token}`);
  const oldModules = path.join(bridgeHome, `.node_modules-old-${token}`);
  const sourceEntries = fs.readdirSync(stage, { withFileTypes: true })
    .filter((entry) => (
      entry.isFile() && (
        entry.name.endsWith('.mjs')
        || entry.name === 'package.json'
        || entry.name === 'package-lock.json'
      )
    ) || (entry.isDirectory() && entry.name === 'project'));
  const newlyAdded = [];
  let modulesInstalled = false;

  fs.mkdirSync(backupDir, { recursive: true });
  for (const entry of sourceEntries) {
    const current = path.join(bridgeHome, entry.name);
    if (fs.existsSync(current)) {
      fs.cpSync(current, path.join(backupDir, entry.name), { recursive: true });
    }
    else newlyAdded.push(current);
  }

  const stagedModules = path.join(stage, 'node_modules');
  if (fs.existsSync(stagedModules)) {
    fs.cpSync(stagedModules, nextModules, { recursive: true });
  }

  try {
    for (const entry of sourceEntries) {
      const source = path.join(stage, entry.name);
      const current = path.join(bridgeHome, entry.name);
      if (entry.isDirectory()) removable(current);
      fs.cpSync(source, current, { recursive: true });
    }
    if (fs.existsSync(stagedModules)) {
      const currentModules = path.join(bridgeHome, 'node_modules');
      if (fs.existsSync(currentModules)) fs.renameSync(currentModules, oldModules);
      fs.renameSync(nextModules, currentModules);
      modulesInstalled = true;
    }
  } catch (error) {
    for (const entry of sourceEntries) {
      const current = path.join(bridgeHome, entry.name);
      const backup = path.join(backupDir, entry.name);
      removable(current);
      if (fs.existsSync(backup)) {
        fs.cpSync(backup, current, { recursive: true });
      }
    }
    for (const target of newlyAdded) removable(target);
    const currentModules = path.join(bridgeHome, 'node_modules');
    if (fs.existsSync(oldModules)) {
      removable(currentModules);
      fs.renameSync(oldModules, currentModules);
    } else if (modulesInstalled) {
      removable(currentModules);
    }
    throw error;
  } finally {
    removable(backupDir);
    removable(nextModules);
    removable(oldModules);
  }
}

// The `>=x.y.z` floor of a staged package's engines.node when the running Node is below it.
export function unmetNodeFloor(stage, current = process.versions.node) {
  const range = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8')).engines?.node || '';
  const floor = /^>=\s*(\d+\.\d+\.\d+)$/.exec(range.trim())?.[1];
  const rank = (v) => v.split('.').reduce((sum, part) => sum * 1000 + Number(part), 0);
  return floor && rank(current) < rank(floor) ? floor : null;
}
