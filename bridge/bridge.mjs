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
import { CLAUDE_PROJECTS, CHECK_STOPPED_INTERVAL, CHECK_UPDATE_INTERVAL, STALL_POLL_INTERVAL_MS, BRIDGE_HOME } from './config.mjs';
import { loadConfig, fetchServerConfig, saveConfig } from './config.mjs';
import { initHttp } from './http.mjs';
import { syncSessions, checkStopped } from './sync.mjs';
import { startWatcher, startJobsWatcher } from './watcher.mjs';
import { checkStalledSessions } from './stall.mjs';
import { initWs } from './ws.mjs';
import { hasTmux } from './tmux.mjs';

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
process.on('exit', () => { try { fs.unlinkSync(LOCK_FILE); } catch {} });
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

const CONFIG = loadConfig();
initHttp(CONFIG);

// Auto-discover WS URL from server (retry every 5 min if network unavailable at boot)
const serverConfig = await fetchServerConfig(CONFIG);
if (serverConfig.wsUrl) CONFIG.wsUrl = serverConfig.wsUrl;

console.log('claude-bridge started');
console.log(`  device:   ${CONFIG.deviceName}`);
console.log(`  server:   ${CONFIG.server}`);
if (CONFIG.wsUrl) console.log(`  ws:       ${CONFIG.wsUrl}`);
console.log(`  tmux:     ${hasTmux() ? 'found (send message enabled)' : 'not found (send message disabled)'}`);
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
await syncSessions(CONFIG, { skipMessages: !!CONFIG.skipInit });
if (CONFIG.skipInit) console.log('[skip-init] metadata synced; skipping historical message upload');
setInterval(() => checkStopped(CONFIG), CHECK_STOPPED_INTERVAL);
// checkStalledSessions is async (confirms over ~2s) — guard against overlapping
// runs if a poll ever takes longer than the interval.
let _stallCheckBusy = false;
setInterval(async () => {
  if (_stallCheckBusy) return;
  _stallCheckBusy = true;
  try { await checkStalledSessions(); } finally { _stallCheckBusy = false; }
}, STALL_POLL_INTERVAL_MS);

// Self-update: every CHECK_UPDATE_INTERVAL, compare local vs server version.
// First tick after boot is a calibration (records version, never upgrades) so
// that re-installing doesn't loop. Subsequent ticks trigger reinstall on mismatch.
let _firstUpdateTick = true;
async function checkUpdate() {
  try {
    const res = await fetch(`${CONFIG.server}/api/version`, { headers: { 'x-api-key': CONFIG.apiKey } });
    if (!res.ok) return;
    const { version } = await res.json();
    if (!version || version === 'dev') return;
    if (_firstUpdateTick) {
      _firstUpdateTick = false;
      if (CONFIG.version !== version) { CONFIG.version = version; saveConfig(CONFIG); }
      return;
    }
    if (version === CONFIG.version) return;
    console.log(`[update] ${CONFIG.version} → ${version}, updating...`);
    CONFIG.version = version;
    saveConfig(CONFIG);
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
      const { execSync: ex } = await import('child_process');
      ex(`curl -sL "${tarUrl}" | tar xz`, { cwd: BRIDGE_HOME, stdio: 'ignore' });
      ex('npm install --production --silent 2>/dev/null', { cwd: BRIDGE_HOME, stdio: 'ignore' });
      console.log(`[update] files updated, restarting...`);
      process.exit(1);
    } catch (e) {
      console.error(`[update] failed: ${e.message}`);
    }
  } catch {}
}
checkUpdate();
setInterval(checkUpdate, CHECK_UPDATE_INTERVAL);

startWatcher(CONFIG);
startJobsWatcher(CONFIG);
