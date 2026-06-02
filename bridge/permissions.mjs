import fs from 'fs';
import path from 'path';
import os from 'os';

const GLOBAL_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

const _cache = new Map();
let _globalRules = null;
let _globalMode = '';
let _globalMtime = 0;

const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'exit_plan_mode']);

function parseRuleString(rule) {
  // "Bash" or "Bash(*)" → { toolName: 'Bash' }
  // "Bash(npm:*)" → { toolName: 'Bash', content: 'npm:*' }
  // "Bash(exact cmd)" → { toolName: 'Bash', content: 'exact cmd' }
  const openIdx = rule.indexOf('(');
  if (openIdx === -1) return { toolName: rule };
  const closeIdx = rule.lastIndexOf(')');
  if (closeIdx <= openIdx) return { toolName: rule };
  const toolName = rule.substring(0, openIdx);
  const content = rule.substring(openIdx + 1, closeIdx);
  if (content === '' || content === '*') return { toolName };
  return { toolName, content };
}

function loadSettings(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return {
      rules: (data.permissions?.allow || []).map(parseRuleString),
      mode: data.permissions?.defaultMode || '',
    };
  } catch { return { rules: [], mode: '' }; }
}

function loadGlobal() {
  try {
    const mtime = fs.statSync(GLOBAL_SETTINGS).mtimeMs;
    if (mtime !== _globalMtime) {
      const s = loadSettings(GLOBAL_SETTINGS);
      _globalRules = s.rules;
      _globalMode = s.mode;
      _globalMtime = mtime;
    }
  } catch {
    _globalRules = [];
    _globalMode = '';
  }
}

function getProjectSettings(projectDir) {
  if (!projectDir) return { rules: [], mode: '' };
  const settingsPath = path.join(projectDir, '.claude', 'settings.local.json');
  try {
    const mtime = fs.statSync(settingsPath).mtimeMs;
    const cached = _cache.get(projectDir);
    if (cached && cached.mtime === mtime) return cached;
    const s = loadSettings(settingsPath);
    const entry = { mtime, rules: s.rules, mode: s.mode };
    _cache.set(projectDir, entry);
    return entry;
  } catch {
    return { rules: [], mode: '' };
  }
}

// Env vars safe to strip before matching. Excludes PATH/LD_*/PYTHONPATH —
// stripping those could mask a hijacked binary.
const SAFE_ENV_VARS = new Set([
  'NODE_ENV', 'PYTHONUNBUFFERED', 'PYTHONDONTWRITEBYTECODE', 'RUST_BACKTRACE',
  'RUST_LOG', 'GOOS', 'GOARCH', 'CGO_ENABLED', 'LANG', 'LC_ALL', 'TZ', 'TERM',
  'NO_COLOR', 'FORCE_COLOR', 'COLORTERM',
]);

// Strip leading safe env assignments (VAR=val) and wrapper commands
// (timeout/nohup/time/nice) so `python3 *` matches `NODE_ENV=x timeout 5 python3 y`.
function stripSafeWrappers(command) {
  let s = command.trim();
  let prev;
  do {
    prev = s;
    const env = s.match(/^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./:-]+)\s+/);
    if (env && SAFE_ENV_VARS.has(env[1])) { s = s.slice(env[0].length); continue; }
    const w = s.match(/^(?:timeout\s+\d+(?:\.\d+)?[smhd]?|nohup|time|nice(?:\s+-n\s+-?\d+)?)\s+/);
    if (w) { s = s.slice(w[0].length); continue; }
  } while (s !== prev);
  return s;
}

function commandMatchesRule(command, ruleContent) {
  if (!ruleContent || !command) return false;
  // prefix:* syntax
  const prefixMatch = ruleContent.match(/^(.+):\*$/);
  if (prefixMatch) return command.startsWith(prefixMatch[1]);
  // wildcard (contains unescaped *)
  if (ruleContent.includes('*')) {
    let escaped = ruleContent.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    // Sole trailing ' *' is optional, so `pip list *` also matches bare `pip list`.
    if (escaped.endsWith(' .*') && (ruleContent.match(/\*/g) || []).length === 1) {
      escaped = escaped.slice(0, -3) + '( .*)?';
    }
    return new RegExp(`^${escaped}$`, 's').test(command);
  }
  // exact match
  return command.trim() === ruleContent.trim();
}

// Split on shell control operators (&& || ; | newline), respecting quotes.
// Every subcommand must match a rule, so `python3 *` can't allow `python3 x && rm -rf /`.
function splitCommand(command) {
  const parts = [];
  let cur = '', q = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') { parts.push(cur); cur = ''; i++; continue; }
    if (c === ';' || c === '|' || c === '\n') { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

export function isToolAllowed(toolName, toolInput, projectDir) {
  if (INTERACTIVE_TOOLS.has(toolName)) return false;

  loadGlobal();
  const project = getProjectSettings(projectDir);

  if (project.mode === 'bypassPermissions' || _globalMode === 'bypassPermissions') return true;

  const rules = [...(_globalRules || []), ...project.rules];

  // Tool-wide rule with no content ("Bash" / "Bash(*)") allows everything.
  for (const rule of rules) {
    if (rule.toolName === toolName && !rule.content) return true;
  }

  if (toolName === 'Bash' || toolName === 'bash') {
    const cmd = toolInput?.command || toolInput?.cmd || '';
    const subs = splitCommand(cmd);
    if (!subs.length) return false;
    // Every subcommand must match a rule (raw or with safe prefixes stripped).
    return subs.every((sub) => {
      const stripped = stripSafeWrappers(sub);
      return rules.some(
        (r) =>
          (r.toolName === 'Bash' || r.toolName === 'bash') &&
          r.content &&
          (commandMatchesRule(sub, r.content) || commandMatchesRule(stripped, r.content)),
      );
    });
  }

  return false;
}

