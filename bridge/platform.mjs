import fs from 'fs';
import path from 'path';
import { execFileSync, spawn } from 'child_process';

export const IS_WINDOWS = process.platform === 'win32';

function executableVariants(candidate) {
  if (!candidate || !IS_WINDOWS || path.extname(candidate)) return candidate ? [candidate] : [];
  return [`${candidate}.exe`, `${candidate}.cmd`, `${candidate}.bat`, candidate];
}

export function findExecutable(name, candidates = []) {
  for (const candidate of candidates.flatMap(executableVariants)) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  try {
    const locator = IS_WINDOWS ? ['where.exe', [name]] : ['/bin/sh', ['-lc', `command -v ${name}`]];
    const found = execFileSync(locator[0], locator[1], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).split(/\r?\n/).find(Boolean);
    return found?.trim() || null;
  } catch {
    return null;
  }
}

export function executableOptions(binary, options = {}, runtime = {}) {
  const platform = runtime.platform || process.platform;
  const nodeExecutable = runtime.nodeExecutable || process.execPath;
  const env = { ...process.env, ...(options.env || {}) };
  if (platform === 'win32') {
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'Path';
    env[pathKey] = `${path.win32.dirname(nodeExecutable)};${env[pathKey] || ''}`;
  }

  return {
    ...options,
    env,
    shell: options.shell ?? (platform === 'win32' && /\.(?:cmd|bat)$/i.test(binary)),
  };
}

export function runExecutable(binary, args, options = {}) {
  return execFileSync(binary, args, executableOptions(binary, options));
}

export function spawnExecutable(binary, args, options = {}, spawnFn = spawn, runtime = {}) {
  return spawnFn(binary, args, executableOptions(binary, options, runtime));
}

export function installProductionDependencies(cwd) {
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const npm = fs.existsSync(npmCli)
    ? [process.execPath, [npmCli, 'install', '--production', '--silent']]
    : [findExecutable('npm', [path.join(path.dirname(process.execPath), 'npm')]), ['install', '--production', '--silent']];
  if (!npm[0]) throw new Error('npm not found');
  let error;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return runExecutable(npm[0], npm[1], { cwd, stdio: 'ignore' }); }
    catch (cause) { error = cause; }
  }
  throw error;
}

export function extractTar(archive, cwd) {
  const windowsTar = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'tar')
    : '';
  const tar = findExecutable('tar', [windowsTar]);
  if (!tar) throw new Error('tar not found');
  return runExecutable(tar, ['xzf', archive, '-C', cwd], { stdio: 'ignore' });
}
