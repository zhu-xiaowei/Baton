import fs from 'fs';
import path from 'path';
import os from 'os';

const HOME = os.homedir();

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function unquote(value) {
  const trimmed = String(value || '').trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed.replace(/\s+#.*$/, '').trim();
}

function readPromptFile(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  raw = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = raw.split('\n');
  const meta = {};
  let bodyStart = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (end > 0) {
      for (let i = 1; i < end; i++) {
        const match = lines[i].match(/^\s*([A-Za-z][\w-]*):\s*(.*?)\s*$/);
        if (!match) continue;
        const key = match[1].toLowerCase();
        let value = match[2];
        if (/^[>|][+-]?$/.test(value)) {
          const block = [];
          while (i + 1 < end && /^\s+/.test(lines[i + 1])) {
            block.push(lines[++i].trim());
          }
          value = value.startsWith('>') ? block.join(' ') : block.join('\n');
        }
        meta[key] = unquote(value);
      }
      bodyStart = end + 1;
    }
  }
  const firstContent = lines.slice(bodyStart).find((line) => line.trim());
  const fallbackDescription = firstContent
    ? firstContent.trim().replace(/^#{1,6}\s+/, '')
    : '';
  return {
    name: meta.name || '',
    description: meta.description || fallbackDescription,
    argumentHint: meta['argument-hint'] || meta.argumenthint || '',
    userInvocable: !/^(false|no|0)$/i.test(meta['user-invocable'] || ''),
  };
}

// Scan a commands/ dir: each *.md is a command; subdirs form ':' namespaces.
function scanCommands(dir, out, source) {
  if (!isDir(dir)) return;
  const walk = (cur, prefix) => {
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        walk(path.join(cur, e.name), prefix + e.name + ':');
      } else if (e.isFile() && e.name.endsWith('.md')) {
        const meta = readPromptFile(path.join(cur, e.name));
        if (!meta?.userInvocable) continue;
        out.push({
          name: prefix + e.name.slice(0, -3),
          source,
          description: meta.description,
          argumentHint: meta.argumentHint,
          behavior: meta.argumentHint ? 'compose' : 'send',
        });
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
    const meta = readPromptFile(path.join(dir, e.name, 'SKILL.md'));
    if (!meta?.userInvocable) continue;
    out.push({
      name: meta.name || e.name,
      source,
      description: meta.description,
      argumentHint: meta.argumentHint,
      behavior: meta.argumentHint ? 'compose' : 'send',
    });
  }
}

// Resolve an enabled plugin's root dir, trying install path then marketplace locations.
function resolvePluginRoot(key, installed, extraMarketplaces, home, claudeDir) {
  const [name, mkt] = key.split('@');
  const candidates = [];
  const recs = installed && installed.plugins && installed.plugins[key];
  if (Array.isArray(recs)) for (const r of recs) if (r.installPath) candidates.push(r.installPath);
  const extra = extraMarketplaces && extraMarketplaces[mkt];
  if (extra && extra.source && extra.source.path) {
    candidates.push(path.join(extra.source.path.replace(/^~/, home), name));
  }
  candidates.push(path.join(claudeDir, 'plugins', 'marketplaces', mkt, 'plugins', name));
  candidates.push(path.join(claudeDir, 'plugins', 'marketplaces', mkt, name));
  return candidates.find(isDir) || null;
}

// Build the full slash-command list for a project: user + project + enabled plugins.
export function scanSlashCommands(projectDir, options = {}) {
  const list = [];
  const home = options.home || HOME;
  const claudeDir = path.join(home, '.claude');

  // User-level (global)
  scanCommands(path.join(claudeDir, 'commands'), list, 'user');
  scanSkills(path.join(claudeDir, 'skills'), list, 'user');

  // Project-level
  if (projectDir && isDir(projectDir)) {
    scanCommands(path.join(projectDir, '.claude', 'commands'), list, 'project');
    scanSkills(path.join(projectDir, '.claude', 'skills'), list, 'project');
  }

  // Enabled plugins
  const settings = readJson(path.join(claudeDir, 'settings.json')) || {};
  const installed = readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json'));
  const enabled = Object.entries(settings.enabledPlugins || {})
    .filter(([, v]) => v).map(([k]) => k);
  for (const key of enabled) {
    const root = resolvePluginRoot(key, installed, settings.extraKnownMarketplaces, home, claudeDir);
    if (!root) continue;
    scanCommands(path.join(root, 'commands'), list, 'plugin');
    scanSkills(path.join(root, 'skills'), list, 'plugin');
  }

  // Old Claude Code fallback: custom commands only. Built-ins are intentionally
  // omitted because a static table becomes incorrect as the CLI evolves.
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
