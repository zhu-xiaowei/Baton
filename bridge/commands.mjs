import fs from 'fs';
import path from 'path';
import os from 'os';

// Built-in commands CC compiles into its binary (bundled skills + builtin slash
// commands) — no file on disk, so the directory scan can't find them. Mirrors
// exactly this CC version's "/" menu beyond disk-scannable commands; re-sync on
// CC upgrades. /clear is excluded on purpose — it spawns a fresh empty session
// each time (clutter, no output); users use the "+" button for a clean context.
const BUILTIN_COMMANDS = [
  'batch', 'code-review', 'compact', 'config', 'context', 'debug',
  'deep-research', 'fewer-permission-prompts', 'goal', 'heapdump', 'init',
  'insights', 'loop', 'reload-skills', 'review', 'run',
  'run-skill-generator', 'security-review', 'simplify', 'stats', 'status',
  'team-onboarding', 'update-config', 'usage', 'verify',
];

// AgentPeek-only commands. The nav/capture flow was tmux; dead under headless, kept for the command-list tag.
export const SYNTHETIC_COMMANDS = {
  'stats-models': { realCmd: '/stats', nav: ['Down', 'Right'] },
};

// "local" commands (CC `type: local`/`local-jsx`) render only in the terminal and
// never write .jsonl. Under headless their output capture is gone — a /cmd is sent
// as plain text and streams back normally; this set just tags them `local` in the
// command list. (/compact is excluded — it writes a <local-command-stdout> row.)
export const LOCAL_COMMANDS = new Set([
  'context', 'usage', 'heapdump',
  'goal', 'reload-skills', 'status', 'config', 'stats',
]);

// Full-screen dialog commands (CC `type: local-jsx`). Dead under headless (was
// tmux Esc-dismiss); kept only so stale imports resolve.
export const DIALOG_COMMANDS = new Set([
  'status', 'config', 'usage', 'stats', 'context',
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

  // Synthetic commands (always local).
  for (const name of Object.keys(SYNTHETIC_COMMANDS)) {
    list.push({ name, source: 'builtin', local: true });
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
