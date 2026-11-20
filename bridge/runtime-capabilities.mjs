import path from 'path';
import os from 'os';
import { DEFAULT_CODEX_HOME } from './config.mjs';
import { cachedRuntimeBin, findRuntimeBin, runtimeNotFoundMessage } from './runtime-bin.mjs';
import { resolveRuntimeLauncher } from './runtime-launcher.mjs';

// The directory of the Node running Bridge, where an older service found npm-installed CLIs.
const lookup = (name, firstDirs) => findRuntimeBin(name, [path.dirname(process.execPath)], undefined, firstDirs)?.bin || null;

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
  return cachedRuntimeBin('codex', () => lookup('codex'));
}

export function resolveClaudeBinForCapability(options = {}) {
  const home = options.home || os.homedir();
  // The native installer's ~/.local/bin, rarely on a service's PATH, goes before an older npm/Homebrew claude.
  return resolveRuntimeLauncher('claude', [], {
    allowShellFallback: true,
    envFile: path.join(home, '.claude/env.sh'),
    findExecutableFn: (name) => lookup(name, [path.join(home, '.local/bin')]),
    ...options,
  });
}

export function claudeLauncherError(options = {}) {
  const env = options.env || process.env;
  return new Error(`${runtimeNotFoundMessage('claude')} PATH: ${env.PATH || env.Path || '(empty)'}; shell: ${env.SHELL || '(not set)'}.`);
}
