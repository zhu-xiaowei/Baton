import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomBytes } from 'crypto';
import { execFileSync } from 'child_process';

export const BRIDGE_HOME = path.join(os.homedir(), '.baton-bridge');
export const CONFIG_PATH = path.join(BRIDGE_HOME, 'config.json');
export const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
export const DEFAULT_CODEX_HOME = path.join(os.homedir(), '.codex');
export const CLAUDE_JOBS = path.join(os.homedir(), '.claude', 'jobs');
export const CLAUDE_DAEMON_ROSTER = path.join(os.homedir(), '.claude', 'daemon', 'roster.json');
export const VALID_TYPES = new Set(['user', 'assistant', 'summary', 'ai-title', 'custom-title', 'last-prompt']);
export const CHECK_STOPPED_INTERVAL = 10 * 60_000; // 10 min — settle stale active rows (pool onExit + jsonl-gone are the fast paths)
export const CODEX_STATUS_STALE_MS = 15 * 60_000;
export const CODEX_STATUS_RECHECK_MS = 30_000;
export const CODEX_WATCH_RESCAN_MS = 5 * 60_000;
export const CODEX_RECENT_FILE_WATCH_LIMIT = 64;

// Cache agent identity plus roster-aware effective status for frequent callers.
export const AGENTS_JSON_TTL_MS = 3000;       // reuse a --json result this long
export const AGENTS_POLL_INTERVAL_MS = 8000;  // scan for agent state changes → sync DDB
export const MAX_POST_BYTES = 4 * 1024 * 1024;
// API Gateway WS single-frame cap is 32768 bytes; exceeding it drops the whole
// connection with code 1009 → reconnect storm. Send truncated copies over WS,
// authoritative tool previews over HTTP to DDB.
// Leave headroom for the JSON envelope.
export const WS_FRAME_LIMIT = 31_000;
// DDB single-item cap is 400KB; keep persisted messages safely under it.
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
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...config, skipInit: undefined }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
}

export function loadConfig() {
  const cliArgs = parseArgs();
  let existing = null;
  if (fs.existsSync(CONFIG_PATH)) {
    try { existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch {}
    try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
  }
  let config;
  if (cliArgs.server && cliArgs.apiKey) {
    const deviceName = existing?.deviceName || cliArgs.deviceName || os.hostname();
    config = {
      server: cliArgs.server,
      apiKey: cliArgs.apiKey,
      deviceName,
      deviceDisplayName: existing?.deviceDisplayName || deviceName,
      bridgeId: existing?.bridgeId,
      wsUrl: existing?.server === cliArgs.server ? existing?.wsUrl : undefined,
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
  if (!/^[a-f0-9]{32}$/.test(config.bridgeId || '')) {
    config.bridgeId = randomBytes(16).toString('hex');
    saveConfig(config);
  }
  return config;
}

// Older installs also wrote --server/--key/--name into the service definition, where other local
// users may read it; config.json is the only source now.
export function removeServiceKeyArgs({ platform = process.platform, home = os.homedir(), exec = execFileSync } = {}) {
  try {
    if (platform === 'darwin') {
      const file = path.join(home, 'Library', 'LaunchAgents', 'com.baton.bridge.plist');
      const text = fs.readFileSync(file, 'utf-8');
      const next = text.replace(/\s*<string>--(?:server|key|name)<\/string>\s*<string>[^<]*<\/string>/g, '');
      if (next === text) return false;
      fs.writeFileSync(file, next);
      return true;
    }
    if (platform === 'linux') {
      const file = path.join(home, '.config', 'systemd', 'user', 'baton-bridge.service');
      const text = fs.readFileSync(file, 'utf-8');
      const next = text.replace(/^(ExecStart=.*?bridge\.mjs) --server .*$/m, '$1');
      if (next === text) return false;
      fs.writeFileSync(file, next);
      exec('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore', timeout: 10_000 });
      return true;
    }
  } catch {}
  return false;
}

// The device was removed in Baton: stop autostart and drop the key. Code and logs stay so a new
// install command can reuse the folder. Unloading the running job would kill this process first,
// so the service files are only removed; the caller then exits with code 0, which neither
// launchd (SuccessfulExit=false) nor systemd (Restart=on-failure) restarts.
export function uninstallBridge({ platform = process.platform, home = os.homedir(), exec = execFileSync } = {}) {
  const run = (command, args) => { try { exec(command, args, { stdio: 'ignore', timeout: 10_000 }); } catch {} };
  if (platform === 'darwin') {
    fs.rmSync(path.join(home, 'Library', 'LaunchAgents', 'com.baton.bridge.plist'), { force: true });
  } else if (platform === 'linux') {
    run('systemctl', ['--user', 'disable', 'baton-bridge']);
    fs.rmSync(path.join(home, '.config', 'systemd', 'user', 'baton-bridge.service'), { force: true });
    run('systemctl', ['--user', 'daemon-reload']);
  } else if (platform === 'win32') {
    run('schtasks', ['/Delete', '/TN', 'Baton Bridge', '/F']);
  }
  fs.rmSync(path.join(home, '.baton-bridge', 'config.json'), { force: true });
}

export async function fetchServerConfig(config) {
  try {
    const res = await fetch(`${config.server}/api/bridge/config`, {
      headers: { 'x-api-key': config.apiKey },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) return await res.json();
  } catch (err) {
    console.error(`Failed to fetch server config: ${err.message}`);
  }
  return {};
}
