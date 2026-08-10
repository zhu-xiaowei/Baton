#!/usr/bin/env node
/**
 * Claude Code Bridge — watches .jsonl session files and syncs to server.
 *
 * Config: ~/.claude-bridge/config.json
 *   { "server": "https://xxx.execute-api.xxx.amazonaws.com/v1", "apiKey": "sk-xxx", "deviceName": "MyMac" }
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CLAUDE_PROJECTS, CHECK_STOPPED_INTERVAL, CHECK_UPDATE_INTERVAL, BRIDGE_HOME } from './config.mjs';
import { loadConfig, fetchServerConfig } from './config.mjs';
import { initHttp } from './http.mjs';
import { syncSessions, checkStopped, reconcile } from './sync.mjs';
import { startRuntimeWatchers } from './runtime-watcher-registry.mjs';
import { initWs, wsSendWhenConnected } from './ws.mjs';
import { loadSynced, saveSynced } from './extract.mjs';
import { BRIDGE_VERSION } from './version.mjs';
import { cleanupStagedBridge, installStagedBridge } from './updater.mjs';
import { extractTar, installProductionDependencies } from './platform.mjs';

// Ensure single instance via PID lock file (cross-platform, works on WSL too)
const LOCK_FILE = path.join(BRIDGE_HOME, 'bridge.pid');
try {
  if (!fs.existsSync(BRIDGE_HOME)) fs.mkdirSync(BRIDGE_HOME, { recursive: true });
  if (fs.existsSync(LOCK_FILE)) {
    const oldPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim());
    if (oldPid && oldPid !== process.pid) {
      try { process.kill(oldPid); console.log(`[init] killed old bridge (PID ${oldPid})`); } catch {}
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
} catch {}
process.on('exit', () => { saveSynced(); try { fs.unlinkSync(LOCK_FILE); } catch {} });
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

const CONFIG = loadConfig();
cleanupStagedBridge(BRIDGE_HOME);
initHttp(CONFIG);
loadSynced(); // restore per-session watermarks before initial sync, so old sessions aren't re-read from 0
setInterval(saveSynced, 60_000).unref(); // crash-fallback flush; exit handler covers clean restarts

// Auto-discover WS URL from server (retry every 5 min if network unavailable at boot)
const serverConfig = await fetchServerConfig(CONFIG);
if (serverConfig.wsUrl) CONFIG.wsUrl = serverConfig.wsUrl;

console.log('claude-bridge started');
console.log(`  device:   ${CONFIG.deviceName}`);
console.log(`  server:   ${CONFIG.server}`);
if (CONFIG.wsUrl) console.log(`  ws:       ${CONFIG.wsUrl}`);
console.log(`  watching: ${CLAUDE_PROJECTS}`);

if (CONFIG.wsUrl) {
  initWs(CONFIG);
} else {
  console.log('[ws] wsUrl not available, will retry every 5 min');
  const wsRetry = setInterval(async () => {
    const sc = await fetchServerConfig(CONFIG);
    if (sc.wsUrl) { CONFIG.wsUrl = sc.wsUrl; clearInterval(wsRetry); initWs(CONFIG); }
  }, 5 * 60_000);
}
// Always run metadata sync (status check + DEV/PROJ/SESS items + lastKnownStatus map).
// --skip-init only skips replaying historical messages — metadata is cheap and required
// for the periodic checkStopped() to detect disappeared CC processes.
const initialSync = await syncSessions(CONFIG, { skipMessages: !!CONFIG.skipInit });
if (CONFIG.skipInit) console.log('[skip-init] metadata synced; skipping historical message upload');
if (initialSync?.messageCount > 0 && CONFIG.wsUrl) {
  wsSendWhenConnected({
    action: 'bridge_recovery_complete',
    deviceName: CONFIG.deviceName,
    count: initialSync.messageCount,
  });
}
// syncSessions has awaited every SESS# write, so DDB is complete — recount now
// (covers first boot + post-upgrade restart). New projects reconcile via the watcher.
if (initialSync?.catalogComplete !== false) await reconcile(CONFIG);
else console.log('[sync] reconcile skipped because local discovery was incomplete');
checkStopped(CONFIG); // run once on boot — pool is empty after restart, so settle just-orphaned running rows now
setInterval(() => checkStopped(CONFIG), CHECK_STOPPED_INTERVAL);

// Compare the immutable package version; config.json is user state.
async function checkUpdate() {
  try {
    const res = await fetch(`${CONFIG.server}/api/version`, { headers: { 'x-api-key': CONFIG.apiKey } });
    if (!res.ok) return;
    const info = await res.json();
    const version = info.bridgeVersion || info.version;
    if (!version || version === 'dev' || version === BRIDGE_VERSION) return;
    console.log(`[update] ${BRIDGE_VERSION} → ${version}, updating...`);
    const serverBase = CONFIG.server.replace(/\/$/, '');
    const nameParam = encodeURIComponent(CONFIG.deviceName || os.hostname());
    const url = `${serverBase}/api/install?name=${nameParam}`;
    try {
      const res = await fetch(url, { headers: { 'x-api-key': CONFIG.apiKey } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const script = await res.text();
      const tarMatch = script.match(/curl -sL "([^"]+)"/);
      if (!tarMatch) throw new Error('no tar URL in install script');
      const tarUrl = tarMatch[1];
      const { execFileSync } = await import('child_process');
      const tgz = path.join(BRIDGE_HOME, '.update.tgz');
      const stage = path.join(BRIDGE_HOME, `.update-stage-${process.pid}`);
      fs.rmSync(stage, { recursive: true, force: true });
      fs.mkdirSync(stage, { recursive: true });
      try {
        const packageRes = await fetch(tarUrl);
        if (!packageRes.ok) throw new Error(`package HTTP ${packageRes.status}`);
        fs.writeFileSync(tgz, Buffer.from(await packageRes.arrayBuffer()));
        extractTar(tgz, stage);
        execFileSync(process.execPath, ['--check', path.join(stage, 'bridge.mjs')], { stdio: 'ignore' });
        installProductionDependencies(stage);

        const stagedVersion = fs.readFileSync(path.join(stage, 'version.mjs'), 'utf-8');
        if (!stagedVersion.includes(`'${version}'`) && !stagedVersion.includes(`"${version}"`)) {
          throw new Error('downloaded Bridge version does not match server');
        }

        installStagedBridge(stage, BRIDGE_HOME);
      } finally {
        fs.rmSync(tgz, { force: true });
        fs.rmSync(stage, { recursive: true, force: true });
      }
      console.log(`[update] files updated, restarting...`);
      process.exit(process.platform === 'win32' ? 75 : 1);
    } catch (e) {
      console.error(`[update] failed: ${e.message}`);
    }
  } catch {}
}
checkUpdate();
setInterval(checkUpdate, CHECK_UPDATE_INTERVAL);

startRuntimeWatchers(CONFIG, { initialSessions: initialSync?.sessions || [] });
