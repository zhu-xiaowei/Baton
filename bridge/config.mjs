import fs from 'fs';
import path from 'path';
import os from 'os';

export const BRIDGE_HOME = path.join(os.homedir(), '.claude-bridge');
export const CONFIG_PATH = path.join(BRIDGE_HOME, 'config.json');
export const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
export const CLAUDE_JOBS = path.join(os.homedir(), '.claude', 'jobs');
export const CLAUDE_DAEMON_ROSTER = path.join(os.homedir(), '.claude', 'daemon', 'roster.json');
export const VALID_TYPES = new Set(['user', 'assistant', 'summary', 'ai-title', 'custom-title', 'last-prompt']);
export const CHECK_STOPPED_INTERVAL = 60_000; // 1 min — resync to catch disappeared CC processes
export const CHECK_UPDATE_INTERVAL = 300_000; // 5 min — self-update poll
export const MAX_POST_BYTES = 4 * 1024 * 1024;

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
  let config;
  if (cliArgs.server && cliArgs.apiKey) {
    config = {
      server: cliArgs.server,
      apiKey: cliArgs.apiKey,
      deviceName: cliArgs.deviceName || os.hostname(),
    };
    fs.mkdirSync(BRIDGE_HOME, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log(`Config saved to ${CONFIG_PATH}`);
  } else if (fs.existsSync(CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
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
