#!/usr/bin/env node
/**
 * Claude Code Bridge — watches .jsonl session files and syncs to server.
 *
 * Config: ~/.claude-bridge/config.json
 *   { "server": "https://xxx.execute-api.xxx.amazonaws.com/v1", "apiKey": "sk-xxx", "deviceName": "MyMac" }
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { CLAUDE_PROJECTS, CHECK_STOPPED_INTERVAL } from './config.mjs';
import { loadConfig, fetchServerConfig } from './config.mjs';
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

// Auto-discover WS URL from server
const serverConfig = await fetchServerConfig(CONFIG);
if (serverConfig.wsUrl) CONFIG.wsUrl = serverConfig.wsUrl;

console.log('claude-bridge started');
console.log(`  device:   ${CONFIG.deviceName}`);
console.log(`  server:   ${CONFIG.server}`);
if (CONFIG.wsUrl) console.log(`  ws:       ${CONFIG.wsUrl}`);
console.log(`  tmux:     ${hasTmux() ? 'found (send message enabled)' : 'not found (send message disabled)'}`);
console.log(`  watching: ${CLAUDE_PROJECTS}`);

initWs(CONFIG);
if (!CONFIG.skipInit) {
  await syncSessions(CONFIG);
  setInterval(() => checkStopped(CONFIG), CHECK_STOPPED_INTERVAL);
} else {
  // Skip to end of all files so we only see new messages
  const { synced } = await import('./extract.mjs');
  for (const project of fs.readdirSync(CLAUDE_PROJECTS)) {
    const dir = path.join(CLAUDE_PROJECTS, project);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
      const fp = path.join(dir, file);
      const lines = fs.readFileSync(fp, 'utf-8').split('\n').length;
      synced.set(file.replace('.jsonl', ''), lines);
    }
  }
  console.log('[skip-init] skipping sync, watching new messages only');
}
startWatcher(CONFIG);
