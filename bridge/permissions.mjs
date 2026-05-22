import fs from 'fs';
import path from 'path';
import os from 'os';

const GLOBAL_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

// Cache: projectDir → allowRules[]
const _cache = new Map();
let _globalRules = null;
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

function loadAllowList(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return (data.permissions?.allow || []).map(parseRuleString);
  } catch { return []; }
}

function getGlobalRules() {
  try {
    const mtime = fs.statSync(GLOBAL_SETTINGS).mtimeMs;
    if (mtime !== _globalMtime) {
      _globalRules = loadAllowList(GLOBAL_SETTINGS);
      _globalMtime = mtime;
    }
  } catch {
    _globalRules = [];
  }
  return _globalRules || [];
}

function getProjectRules(projectDir) {
  if (!projectDir) return [];
  const settingsPath = path.join(projectDir, '.claude', 'settings.local.json');
  try {
    const mtime = fs.statSync(settingsPath).mtimeMs;
    const cached = _cache.get(projectDir);
    if (cached && cached.mtime === mtime) return cached.rules;
    const rules = loadAllowList(settingsPath);
    _cache.set(projectDir, { mtime, rules });
    return rules;
  } catch {
    return [];
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
  // Interactive tools always need permission (they await user response)
  if (INTERACTIVE_TOOLS.has(toolName)) return false;

  const rules = [...getGlobalRules(), ...getProjectRules(projectDir)];

  for (const rule of rules) {
    if (rule.toolName !== toolName) continue;
    // Tool-wide allow (no content restriction)
    if (!rule.content) return true;
    // Content-specific match (Bash commands)
    if (toolName === 'Bash' || toolName === 'bash') {
      const cmd = toolInput?.command || toolInput?.cmd || '';
      if (commandMatchesRule(cmd, rule.content)) return true;
    }
  }
  return false;
}

