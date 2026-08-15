import fs from 'fs';
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

export function installStagedBridge(stage, bridgeHome) {
  const token = `${process.pid}-${Date.now()}`;
  const backupDir = path.join(bridgeHome, `.update-backup-${token}`);
  const nextModules = path.join(bridgeHome, `.node_modules-next-${token}`);
  const oldModules = path.join(bridgeHome, `.node_modules-old-${token}`);
  const sourceEntries = fs.readdirSync(stage, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (
      entry.name.endsWith('.mjs')
      || entry.name === 'package.json'
      || entry.name === 'package-lock.json'
    ));
  const newlyAdded = [];
  let modulesInstalled = false;

  fs.mkdirSync(backupDir, { recursive: true });
  for (const entry of sourceEntries) {
    const current = path.join(bridgeHome, entry.name);
    if (fs.existsSync(current)) fs.copyFileSync(current, path.join(backupDir, entry.name));
    else newlyAdded.push(current);
  }

  const stagedModules = path.join(stage, 'node_modules');
  if (fs.existsSync(stagedModules)) {
    fs.cpSync(stagedModules, nextModules, { recursive: true });
  }

  try {
    for (const entry of sourceEntries) {
      fs.copyFileSync(path.join(stage, entry.name), path.join(bridgeHome, entry.name));
    }
    if (fs.existsSync(stagedModules)) {
      const currentModules = path.join(bridgeHome, 'node_modules');
      if (fs.existsSync(currentModules)) fs.renameSync(currentModules, oldModules);
      fs.renameSync(nextModules, currentModules);
      modulesInstalled = true;
    }
  } catch (error) {
    for (const entry of fs.readdirSync(backupDir, { withFileTypes: true })) {
      if (entry.isFile()) fs.copyFileSync(path.join(backupDir, entry.name), path.join(bridgeHome, entry.name));
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
