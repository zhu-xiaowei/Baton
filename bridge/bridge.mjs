#!/usr/bin/env node
/**
 * Baton Bridge — serves local agent runtimes to the App over the direct channel.
 *
 * Config: ~/.baton-bridge/config.json
 *   { "server": "https://xxx.execute-api.xxx.amazonaws.com/v1", "apiKey": "sk-xxx", "deviceName": "MyMac" }
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CLAUDE_PROJECTS, CHECK_STOPPED_INTERVAL, BRIDGE_HOME } from './config.mjs';
import { loadConfig, removeServiceKeyArgs, saveConfig } from './config.mjs';
import { acquireInstanceLock } from './instance-lock.mjs';
import { initHttp } from './http.mjs';
import { syncSessions, checkStopped, lastKnownStatus } from './sync.mjs';
import { sessionIndex } from './session-index.mjs';
import { startRuntimeWatchers } from './runtime-watcher-registry.mjs';
import { registerInstalledRuntimes } from './runtime-registry.mjs';
import { closeTerminalsForUpdate, initWs, shutdownInteractions, setUpdateChecker } from './ws.mjs';
import { BRIDGE_VERSION } from './version.mjs';
import {
  cleanupStagedBridge,
  cleanupUpdateWorkspace,
  createUpdateWorkspace,
  installStagedBridge,
  unmetNodeFloor,
} from './updater.mjs';
import { extractTar, installProductionDependencies } from './platform.mjs';

const releaseInstanceLock = await acquireInstanceLock(BRIDGE_HOME);
if (!releaseInstanceLock) {
  console.log('[init] another Bridge instance is already running; exiting');
  process.exit(0);
}
process.on('exit', () => releaseInstanceLock());
let shuttingDown = false;
let updateInProgress = false;
let nextUpdateCheckAt = 0;
let skippedVersion = '';
async function shutdownBridge(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  await shutdownInteractions();
  process.exit(exitCode);
}
process.on('SIGTERM', () => { shutdownBridge(0).catch(() => process.exit(1)); });
process.on('SIGINT', () => { shutdownBridge(0).catch(() => process.exit(1)); });

const CONFIG = loadConfig();
if (removeServiceKeyArgs()) console.log('[init] removed the key from the service definition');
cleanupStagedBridge(BRIDGE_HOME);
initHttp(CONFIG);

console.log('Baton Bridge started');
console.log(`  device:   ${CONFIG.deviceName}`);
console.log(`  server:   ${CONFIG.server}`);
console.log(`  ws:       ${CONFIG.wsUrl || '-'}`);
console.log(`  watching: ${CLAUDE_PROJECTS}`);

// The control socket's address is kept in config.json; the first start asks /devices for it.
while (!CONFIG.wsUrl && !shuttingDown) {
  try {
    const res = await fetch(`${CONFIG.server}/api/bridge/devices`, {
      headers: { 'x-api-key': CONFIG.apiKey }, signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) CONFIG.wsUrl = (await res.json()).wsUrl || '';
  } catch {}
  if (CONFIG.wsUrl) saveConfig(CONFIG);
  else await new Promise((resolve) => setTimeout(resolve, 10_000));
}
await registerInstalledRuntimes();
initWs(CONFIG, { onSuperseded: () => shutdownBridge(0) });
sessionIndex.statuses = lastKnownStatus;
lastKnownStatus.onChange = () => sessionIndex.markStatus();
const warmed = sessionIndex.warm().catch((error) => console.error(`[session-index] warm failed: ${error.message}`));
const initialSync = syncSessions(CONFIG);
// Once the index knows every root, settle the rows left running by the previous process.
warmed.then(() => checkStopped(CONFIG));
setInterval(() => checkStopped(CONFIG), CHECK_STOPPED_INTERVAL);

// Compare the immutable package version; config.json is user state.
async function checkUpdate() {
  if (shuttingDown || updateInProgress || Date.now() < nextUpdateCheckAt) return;
  nextUpdateCheckAt = Date.now() + 4 * 60_000;
  updateInProgress = true;
  try {
    const res = await fetch(`${CONFIG.server}/api/version`, {
      headers: { 'x-api-key': CONFIG.apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return;
    const info = await res.json();
    const version = info.bridgeVersion || info.version;
    if (!version || version === 'dev' || version === BRIDGE_VERSION || version === skippedVersion) return;
    console.log(`[update] ${BRIDGE_VERSION} → ${version}, updating...`);
    const serverBase = CONFIG.server.replace(/\/$/, '');
    const nameParam = encodeURIComponent(CONFIG.deviceName || os.hostname());
    const url = `${serverBase}/api/install?name=${nameParam}`;
    try {
      const res = await fetch(url, {
        headers: { 'x-api-key': CONFIG.apiKey },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const script = await res.text();
      const tarMatch = script.match(/curl -sL "([^"]+)"/);
      if (!tarMatch) throw new Error('no tar URL in install script');
      const tarUrl = tarMatch[1];
      const { execFileSync } = await import('child_process');
      const workspace = createUpdateWorkspace(BRIDGE_HOME);
      const { archive: tgz, stage } = workspace;
      try {
        const packageRes = await fetch(tarUrl, { signal: AbortSignal.timeout(120_000) });
        if (!packageRes.ok) throw new Error(`package HTTP ${packageRes.status}`);
        fs.writeFileSync(tgz, Buffer.from(await packageRes.arrayBuffer()));
        extractTar(tgz, stage);
        const floor = unmetNodeFloor(stage);
        if (floor) {
          skippedVersion = version;
          console.log(`[update] ${version} needs Node.js >= ${floor} (running ${process.versions.node}), update skipped`);
          return;
        }
        execFileSync(process.execPath, ['--check', path.join(stage, 'bridge.mjs')], { stdio: 'ignore' });
        installProductionDependencies(stage);

        const stagedVersion = fs.readFileSync(path.join(stage, 'version.mjs'), 'utf-8');
        if (!stagedVersion.includes(`'${version}'`) && !stagedVersion.includes(`"${version}"`)) {
          throw new Error('downloaded Bridge version does not match server');
        }

        if (process.platform === 'win32') await closeTerminalsForUpdate();
        installStagedBridge(stage, BRIDGE_HOME);
      } finally {
        cleanupUpdateWorkspace(workspace);
      }
      console.log(`[update] files updated, restarting...`);
      await shutdownBridge(process.platform === 'win32' ? 75 : 1);
    } catch (e) {
      console.error(`[update] failed: ${e.message}`);
    }
  } catch {} finally {
    updateInProgress = false;
  }
}
checkUpdate();
setUpdateChecker(checkUpdate);

startRuntimeWatchers(CONFIG, { initialSessions: initialSync?.sessions || [] });
