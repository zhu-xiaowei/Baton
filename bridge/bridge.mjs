#!/usr/bin/env node
/**
 * Claude Code Bridge — watches .jsonl session files and syncs to server.
 *
 * Config: ~/.claude-bridge/config.json
 *   { "server": "https://xxx.execute-api.xxx.amazonaws.com/v1", "apiKey": "sk-xxx", "deviceName": "MyMac" }
 */

import { execSync, spawn } from 'child_process';
import { CLAUDE_PROJECTS, CHECK_STOPPED_INTERVAL } from './config.mjs';
import { loadConfig, fetchServerConfig, saveConfig } from './config.mjs';
import { initHttp } from './http.mjs';
import { syncSessions, checkStopped } from './sync.mjs';
import { startWatcher } from './watcher.mjs';
import { initWs } from './ws.mjs';
import { hasTmux } from './tmux.mjs';

// Ensure single instance: kill old bridge processes, graceful exit on SIGTERM
try {
  const lines = execSync('ps aux 2>/dev/null').toString().split('\n');
  for (const line of lines) {
    if (!line.includes('bridge.mjs') || line.includes('grep')) continue;
    const pid = parseInt(line.trim().split(/\s+/)[1]);
    if (pid && pid !== process.pid) {
      try { process.kill(pid); console.log(`[init] killed old bridge (PID ${pid})`); } catch {}
    }
  }
} catch {}
process.on('SIGTERM', () => process.exit(0));

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

// Self-update: every CHECK_STOPPED_INTERVAL, compare local vs server version.
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
    console.log(`[update] ${CONFIG.version} → ${version}, reinstalling...`);
    // Update CONFIG.version BEFORE spawn so a failed install won't re-trigger every tick.
    CONFIG.version = version;
    saveConfig(CONFIG);
    const baseUrl = CONFIG.server.replace(/\/v1\/?$/, '');
    spawn('bash', ['-c', `curl -sL -H "x-api-key: $X_API_KEY" "${baseUrl}/api/install" | bash`],
      { detached: true, stdio: 'ignore', env: { ...process.env, X_API_KEY: CONFIG.apiKey } }).unref();
  } catch {}
}
checkUpdate();
setInterval(checkUpdate, CHECK_STOPPED_INTERVAL);

startWatcher(CONFIG);
