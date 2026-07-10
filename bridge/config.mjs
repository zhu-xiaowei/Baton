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

// Stall rescue: a multi-question AskUserQuestion wizard holds its tool_use in
// CC's memory until the user hits Submit, never writing to jsonl — so a session
// can look permanently "running" with no way to see or answer the question.
//
// jsonl silence alone can't tell "CC is still thinking" (perfectly normal —
// the file doesn't update while a turn is being generated) apart from "wizard
// really is stuck". So detection is two gates: a cheap jsonl-mtime pre-filter,
// then a terminal-content check for the wizard's own UI chrome, confirmed
// stable across two polls before rescuing (a wizard that just rendered this
// instant fails the stability check and is left alone).
export const STALL_POLL_INTERVAL_MS = 5000;   // how often to scan for stuck sessions
export const STALL_JSONL_SILENCE_MS = 5000;   // pre-filter: skip capture-pane unless jsonl has been quiet this long
export const STALL_CONFIRM_INTERVAL_MS = 2000; // gap between the two confirming captures
export const STALL_ARM_TIMEOUT_MS = 8000;     // give up waiting for the rescued tool_use/tool_result pair
// Agent state comes from `claude agents --json --all` (daemon-live, unlike the
// stale jobs/*/state.json files). Cache the CLI output briefly (high-frequency
// callers) and poll for changes to push status updates.
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
