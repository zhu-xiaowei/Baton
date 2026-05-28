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

function commandMatchesRule(command, ruleContent) {
  if (!ruleContent || !command) return false;
  // prefix:* syntax
  const prefixMatch = ruleContent.match(/^(.+):\*$/);
  if (prefixMatch) return command.startsWith(prefixMatch[1]);
  // wildcard (contains unescaped *)
  if (ruleContent.includes('*')) {
    const escaped = ruleContent.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`, 's').test(command);
  }
  // exact match
  return command.trim() === ruleContent.trim();
}

export function isToolAllowed(toolName, toolInput, projectDir) {
  if (INTERACTIVE_TOOLS.has(toolName)) return false;

  loadGlobal();
  const project = getProjectSettings(projectDir);

  if (project.mode === 'bypassPermissions' || _globalMode === 'bypassPermissions') return true;

  const rules = [...(_globalRules || []), ...project.rules];

  for (const rule of rules) {
    if (rule.toolName !== toolName) continue;
    if (!rule.content) return true;
    if (toolName === 'Bash' || toolName === 'bash') {
      const cmd = toolInput?.command || toolInput?.cmd || '';
      if (commandMatchesRule(cmd, rule.content)) return true;
    }
  }
  return false;
}

