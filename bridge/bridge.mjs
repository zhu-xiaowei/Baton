#!/usr/bin/env node
/**
 * Claude Code Bridge — watches .jsonl session files and syncs to server.
 *
 * Config: ~/.claude-bridge/config.json
 *   { "server": "https://xxx.execute-api.xxx.amazonaws.com/v1", "apiKey": "sk-xxx", "deviceName": "MyMac" }
 */

import { CLAUDE_PROJECTS, SYNC_INTERVAL } from './config.mjs';
import { loadConfig } from './config.mjs';
import { initHttp } from './http.mjs';
import { syncSessions } from './sync.mjs';
import { startWatcher } from './watcher.mjs';
import { initWs } from './ws.mjs';

const CONFIG = loadConfig();
initHttp(CONFIG);

console.log('claude-bridge started');
console.log(`  device:   ${CONFIG.deviceName}`);
console.log(`  server:   ${CONFIG.server}`);
console.log(`  watching: ${CLAUDE_PROJECTS}`);

await syncSessions(CONFIG);
startWatcher(CONFIG);
initWs(CONFIG);
setInterval(() => syncSessions(CONFIG), SYNC_INTERVAL);
