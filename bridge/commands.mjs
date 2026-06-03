import fs from 'fs';
import path from 'path';
import os from 'os';

// Built-in commands that CC ships compiled into its binary (bundled skills +
// builtin slash commands) — they have NO file on disk, so the directory scan
// can't find them. This list mirrors exactly what THIS CC version shows in its
// "/" menu beyond the disk-scannable commands. Keep it in sync with the actual
// menu on CC upgrades (CC may add/remove bundled skills between versions).
// NOTE: we intentionally do NOT pad this with the full COMMANDS() set — only
// commands the running CC actually surfaces belong here, so our list matches
// CC 1:1 (no extras the user never sees, none of CC's hidden/gated commands).
const BUILTIN_COMMANDS = [
  'batch', 'clear', 'code-review', 'compact', 'context', 'debug',
  'deep-research', 'fewer-permission-prompts', 'goal', 'heapdump', 'init',
  'insights', 'loop', 'reload-skills', 'remote-control', 'review', 'run',
  'run-skill-generator', 'security-review', 'simplify', 'team-onboarding',
  'update-config', 'usage', 'verify',
];

// "local" commands run client-side in CC and render output only in the terminal
// — they never write to the .jsonl, so the bridge/app can't receive their result
// (the app would loading-spin forever). We flag them with `local: true`; the web
// UI hides them for now. They DO execute in CC if sent — we just can't show their
// output yet. TODO: surface them by grabbing terminal output via
// `tmux capture-pane` after send and pushing it over WS (see the "tmux capture-pane
// Live State" plan in CLAUDE.md). Source: CC command `type: local`/`local-jsx`;
// re-check on CC upgrades.
const LOCAL_COMMANDS = new Set([
  'clear', 'compact', 'context', 'usage', 'heapdump', 'remote-control',
  'goal', 'reload-skills',
]);

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const USER_COMMANDS = path.join(CLAUDE_DIR, 'commands');
const USER_SKILLS = path.join(CLAUDE_DIR, 'skills');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const INSTALLED_PLUGINS = path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// Read a skill's command name from SKILL.md frontmatter `name` (CC's rule),
// falling back to the directory name. Returns null if SKILL.md is missing.
function readSkillName(skillFile, dirName) {
  let raw;
  try { raw = fs.readFileSync(skillFile, 'utf-8'); } catch { return null; }
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3);
    if (end !== -1) {
      for (const line of raw.slice(3, end).split('\n')) {
        const m = line.match(/^name:\s*(.+?)\s*$/);
        if (m) return m[1].replace(/^["']|["']$/g, '');
      }
    }
  }
  return dirName;
}

// Scan a commands/ dir: each *.md is a command; subdirs form ':' namespaces.
// Name comes from the filename — no need to read file contents.
function scanCommands(dir, out, source) {
  if (!isDir(dir)) return;
  const walk = (cur, prefix) => {
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        walk(path.join(cur, e.name), prefix + e.name + ':');
      } else if (e.isFile() && e.name.endsWith('.md')) {
        out.push({ name: prefix + e.name.slice(0, -3), source });
      }
    }
  };
  walk(dir, '');
}

// Scan a skills/ dir: each subdir with SKILL.md is a skill.
function scanSkills(dir, out, source) {
  if (!isDir(dir)) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const name = readSkillName(path.join(dir, e.name, 'SKILL.md'), e.name);
    if (name) out.push({ name, source });
  }
}

// Resolve an enabled plugin's root dir, trying install path then marketplace locations.
function resolvePluginRoot(key, installed, extraMarketplaces) {
  const [name, mkt] = key.split('@');
  const candidates = [];
  const recs = installed && installed.plugins && installed.plugins[key];
  if (Array.isArray(recs)) for (const r of recs) if (r.installPath) candidates.push(r.installPath);
  const extra = extraMarketplaces && extraMarketplaces[mkt];
  if (extra && extra.source && extra.source.path) {
    candidates.push(path.join(extra.source.path.replace(/^~/, HOME), name));
  }
  candidates.push(path.join(CLAUDE_DIR, 'plugins', 'marketplaces', mkt, 'plugins', name));
  candidates.push(path.join(CLAUDE_DIR, 'plugins', 'marketplaces', mkt, name));
  return candidates.find(isDir) || null;
}

// Build the full slash-command list for a project: user + project + enabled plugins.
export function scanSlashCommands(projectDir) {
  const list = [];

  // User-level (global)
  scanCommands(USER_COMMANDS, list, 'user');
  scanSkills(USER_SKILLS, list, 'user');

  // Project-level
  if (projectDir && isDir(projectDir)) {
    scanCommands(path.join(projectDir, '.claude', 'commands'), list, 'project');
    scanSkills(path.join(projectDir, '.claude', 'skills'), list, 'project');
  }

  // Enabled plugins
  const settings = readJson(SETTINGS) || {};
  const installed = readJson(INSTALLED_PLUGINS);
  const enabled = Object.entries(settings.enabledPlugins || {})
    .filter(([, v]) => v).map(([k]) => k);
  for (const key of enabled) {
    const root = resolvePluginRoot(key, installed, settings.extraKnownMarketplaces);
    if (!root) continue;
    scanCommands(path.join(root, 'commands'), list, 'plugin');
    scanSkills(path.join(root, 'skills'), list, 'plugin');
  }

  // Built-in commands (compiled into CC, no file on disk).
  for (const name of BUILTIN_COMMANDS) {
    const c = { name, source: 'builtin' };
    if (LOCAL_COMMANDS.has(name)) c.local = true;
    list.push(c);
  }

  // Dedup by name, keeping first occurrence (user > project > plugin > builtin).
  const seen = new Set();
  const result = [];
  for (const c of list) {
    if (!c.name || seen.has(c.name)) continue;
    seen.add(c.name);
    result.push(c);
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}
