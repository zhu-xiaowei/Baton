import fs from 'fs';
import path from 'path';
import os from 'os';
import { DEFAULT_CODEX_HOME } from './config.mjs';
import { findExecutable, runExecutable } from './platform.mjs';

export function existingDirectory(value) {
  try { return fs.statSync(value).isDirectory(); } catch { return false; }
}

export function resolveCodexHomes(env = process.env) {
  const candidates = [];
  if (env.CODEX_HOME) candidates.push(env.CODEX_HOME);
  candidates.push(DEFAULT_CODEX_HOME);

  const seen = new Set();
  return candidates.filter(Boolean).filter((candidate) => {
    const normalized = path.resolve(candidate);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

export function resolveCodexBin() {
  const home = os.homedir();
  return findExecutable('codex', [
    path.join(home, '.local/bin/codex'),
    path.join(home, '.npm-global/bin/codex'),
    path.join(home, 'AppData/Roaming/npm/codex'),
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
    '/usr/bin/codex',
  ]);
}

export function resolveClaudeBinForCapability() {
  const home = os.homedir();
  return findExecutable('claude', [
    path.join(home, '.local/bin/claude'),
    path.join(home, 'AppData/Roaming/npm/claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    '/usr/bin/claude',
  ]);
}

export function binaryVersion(binary) {
  if (!binary) return '';
  try {
    return runExecutable(binary, ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().slice(0, 120);
  } catch {
    return '';
  }
}
