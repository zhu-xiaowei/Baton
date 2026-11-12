// Locate a runtime CLI and a Node.js binary without trusting the service's PATH.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { IS_WINDOWS, runExecutable } from './platform.mjs';

const HOME = os.homedir();
const NAMES = (name) => (IS_WINDOWS ? [`${name}.exe`, `${name}.cmd`, name] : [name]);

const rank = (v) => String(v).replace(/^v/, '').split('.').slice(0, 3).reduce((sum, part) => sum * 1000 + (parseInt(part, 10) || 0), 0);

// <root>/<version>/<suffix> for every installed version, newest first.
function versionDirs(root, suffix) {
  try {
    return fs.readdirSync(root).sort((a, b) => rank(b) - rank(a)).map((v) => path.join(root, v, suffix));
  } catch { return []; }
}

// Node version managers' install directories, each holding a node binary.
export function nodeDirs() {
  const bin = IS_WINDOWS ? '' : 'bin';
  const fnm = process.env.FNM_DIR || (process.platform === 'darwin'
    ? path.join(HOME, 'Library/Application Support/fnm') : path.join(HOME, '.local/share/fnm'));
  return [
    ...versionDirs(path.join(process.env.NVM_DIR || path.join(HOME, '.nvm'), 'versions/node'), bin),
    ...versionDirs(path.join(fnm, 'node-versions'), path.join('installation', bin)),
    ...versionDirs(path.join(process.env.VOLTA_HOME || path.join(HOME, '.volta'), 'tools/image/node'), bin),
  ];
}

function commonDirs() {
  return [
    path.join(process.env.VOLTA_HOME || path.join(HOME, '.volta'), 'bin'),
    path.join(HOME, '.local/bin'),
    '/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin',
    ...(process.env.APPDATA ? [path.join(process.env.APPDATA, 'npm')] : []),
    ...nodeDirs(),
  ];
}

function version(bin) {
  try {
    return String(runExecutable(bin, ['--version'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })).trim();
  } catch { return null; }
}

function loginShellLookup(name) {
  if (IS_WINDOWS || !/^[\w.-]+$/.test(name)) return null;
  try {
    return execFileSync(process.env.SHELL || '/bin/sh', ['-lc', `command -v ${name}`], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split('\n').at(-1) || null;
  } catch { return null; }
}

// The first `name` in PATH, `dirs`, the usual install directories, then the login shell's lookup,
// whose `--version` exits 0 and, with `minVersion`, reports at least that (PATH may hold an old 1.x).
export function findRuntimeBin(name, dirs = [], minVersion) {
  const accept = (bin) => {
    const v = version(bin);
    return v !== null && (!minVersion || rank(/\d+\.\d+\.\d+/.exec(v)?.[0]) >= rank(minVersion)) ? { bin, version: v } : null;
  };
  const pathDirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  const seen = new Set();
  for (const dir of [...pathDirs, ...dirs, ...commonDirs()]) {
    for (const file of NAMES(name)) {
      const bin = path.join(dir, file);
      if (seen.has(bin)) continue;
      seen.add(bin);
      try { if (!fs.statSync(bin).isFile()) continue; } catch { continue; }
      const found = accept(bin);
      if (found) return found;
    }
  }
  const bin = loginShellLookup(name);
  return bin && !seen.has(bin) ? accept(bin) : null;
}

// A node binary at least `minVersion`: Bridge's own first, then version-manager installs.
export function pickNode(minVersion) {
  if (rank(process.versions.node) >= rank(minVersion)) return { bin: process.execPath, version: process.version };
  for (const dir of nodeDirs()) {
    const bin = path.join(dir, IS_WINDOWS ? 'node.exe' : 'node');
    if (!fs.existsSync(bin)) continue;
    const v = version(bin);
    if (v && rank(v) >= rank(minVersion)) return { bin, version: v };
  }
  return null;
}
