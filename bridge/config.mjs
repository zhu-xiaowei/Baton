import fs from 'fs';
import path from 'path';
import os from 'os';

export const BRIDGE_HOME = path.join(os.homedir(), '.baton-bridge');
export const CONFIG_PATH = path.join(BRIDGE_HOME, 'config.json');
export const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
export const DEFAULT_CODEX_HOME = path.join(os.homedir(), '.codex');
export const CLAUDE_JOBS = path.join(os.homedir(), '.claude', 'jobs');
export const CLAUDE_DAEMON_ROSTER = path.join(os.homedir(), '.claude', 'daemon', 'roster.json');
export const VALID_TYPES = new Set(['user', 'assistant', 'summary', 'ai-title', 'custom-title', 'last-prompt']);
export const CHECK_STOPPED_INTERVAL = 10 * 60_000; // 10 min — settle stale active rows (pool onExit + jsonl-gone are the fast paths)
export const CHECK_UPDATE_INTERVAL = 300_000; // 5 min — self-update poll
export const CODEX_STATUS_STALE_MS = 5 * 60_000;
export const CODEX_STATUS_RECHECK_MS = 30_000;
export const CODEX_WATCH_RESCAN_MS = 5 * 60_000;
export const CODEX_RECENT_FILE_WATCH_LIMIT = 64;

// Cache agent identity plus roster-aware effective status for frequent callers.
export const AGENTS_JSON_TTL_MS = 3000;       // reuse a --json result this long
export const AGENTS_POLL_INTERVAL_MS = 8000;  // scan for agent state changes → sync DDB
export const MAX_POST_BYTES = 4 * 1024 * 1024;
// API Gateway WS single-frame cap is 32768 bytes; exceeding it drops the whole
// connection with code 1009 → reconnect storm. Send truncated copies over WS,
// full copies over HTTP to DDB. Leave headroom for the JSON envelope.
export const WS_FRAME_LIMIT = 31_000;
// DDB single-item cap is 400KB; keep full messages safely under it.
export const DDB_ITEM_LIMIT = 360_000;

// WSL detection: fs.watch inotify doesn't work on /mnt/ (9P filesystem)
export const IS_WSL = !!process.env.WSL_DISTRO_NAME;
export const NEEDS_POLLING = IS_WSL && CLAUDE_PROJECTS.startsWith('/mnt/');

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--server' && args[i + 1]) parsed.server = args[++i];
    else if (args[i] === '--key' && args[i + 1]) parsed.apiKey = args[++i];
    else if (args[i] === '--name' && args[i + 1]) parsed.deviceName = args[++i];
    else if (args[i] === '--skip-init') parsed.skipInit = true;
  }
  return parsed;
}

export function saveConfig(config) {
  fs.mkdirSync(BRIDGE_HOME, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function loadConfig() {
  const cliArgs = parseArgs();
  let existing = null;
  if (fs.existsSync(CONFIG_PATH)) {
    try { existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch {}
  }
  let config;
  if (cliArgs.server && cliArgs.apiKey) {
    const deviceName = existing?.deviceName || cliArgs.deviceName || os.hostname();
    config = {
      server: cliArgs.server,
      apiKey: cliArgs.apiKey,
      deviceName,
      deviceDisplayName: existing?.deviceDisplayName || deviceName,
    };
    saveConfig(config);
    console.log(`Config saved to ${CONFIG_PATH}`);
  } else if (existing) {
    config = existing;
    if (!config.deviceDisplayName) {
      config.deviceDisplayName = config.deviceName;
      saveConfig(config);
    }
    if (cliArgs.skipInit) config.skipInit = true;
  } else {
    console.error('Usage: node bridge.mjs --server URL --key API_KEY [--name DEVICE_NAME]');
    process.exit(1);
  }
  return config;
}

export async function fetchServerConfig(config) {
  try {
    const res = await fetch(`${config.server}/api/bridge/config`, {
      headers: { 'x-api-key': config.apiKey },
    });
    if (res.ok) return await res.json();
  } catch (err) {
    console.error(`Failed to fetch server config: ${err.message}`);
  }
  return {};
}
