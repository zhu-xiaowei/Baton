import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { findExecutable } from './platform.mjs';

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function launcherDetails(name, candidates, options = {}) {
  const env = options.env || process.env;
  return {
    checked: [...new Set([name, ...candidates].filter(Boolean))],
    path: env.PATH || env.Path || env.path || '(empty)',
    shell: env.SHELL || '(not set)',
  };
}

export function runtimeLauncherError(name, candidates = [], options = {}) {
  const details = launcherDetails(name, candidates, options);
  return new Error(
    `Baton Bridge could not launch ${name}. `
    + `Checked binaries: ${details.checked.join(', ')}; `
    + `PATH: ${details.path}; shell: ${details.shell}.`,
  );
}

function writeLauncher(name, content, options = {}) {
  const bridgeHome = options.bridgeHome || path.join(os.homedir(), '.baton-bridge');
  const launcherDir = path.join(bridgeHome, 'runtime-launchers');
  const launcherPath = path.join(launcherDir, name);

  fs.mkdirSync(launcherDir, { recursive: true, mode: 0o700 });
  try {
    if (fs.readFileSync(launcherPath, 'utf8') === content) {
      fs.chmodSync(launcherPath, 0o700);
      return launcherPath;
    }
  } catch {}
  fs.writeFileSync(launcherPath, content, { mode: 0o700 });
  fs.chmodSync(launcherPath, 0o700);
  return launcherPath;
}

function withEnvironmentFile(name, binary, options) {
  if (!binary || !options.envFile || !fs.existsSync(options.envFile)) return binary;
  if ((options.platform || process.platform) === 'win32') return binary;

  const home = options.home || os.homedir();
  const nodeDirectory = path.dirname(options.nodeExecutable || process.execPath);
  const pathPrefix = [...new Set([nodeDirectory, path.join(home, '.local/bin')])].join(':');
  const envFile = shellQuote(options.envFile);
  return writeLauncher(`${name}-env`, [
    '#!/bin/bash',
    `if [ -f ${envFile} ]; then`,
    '  set -a',
    `  source ${envFile} </dev/null 1>&2 || exit $?`,
    '  set +a',
    'fi',
    `export PATH=${shellQuote(pathPrefix)}:"\${PATH:-/usr/local/bin:/usr/bin:/bin}"`,
    `exec ${shellQuote(binary)} "$@"`,
    '',
  ].join('\n'), options);
}

function writeShellLauncher(name, shell, candidates, options = {}) {
  const details = launcherDetails(name, candidates, options);
  const command = `exec 1>&3; ${name} "$@"`;
  const failure = `Baton Bridge could not launch ${name}. `
    + `Checked binaries: ${details.checked.join(', ')}; `
    + `PATH: ${details.path}; shell: ${shell}.`;
  const content = [
    '#!/bin/sh',
    `${shellQuote(shell)} -ic ${shellQuote(command)} ${shellQuote(`baton-bridge-${name}`)} "$@" 3>&1 1>&2`,
    'status=$?',
    'if [ "$status" -eq 126 ] || [ "$status" -eq 127 ]; then',
    `  printf '%s\\n' ${shellQuote(failure)} >&2`,
    'fi',
    'exit "$status"',
    '',
  ].join('\n');

  return writeLauncher(name, content, options);
}

export function resolveRuntimeLauncher(name, candidates = [], options = {}) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`Invalid runtime executable name: ${name}`);
  }
  const finder = options.findExecutableFn || findExecutable;
  const direct = finder(name, candidates);
  if (direct) return withEnvironmentFile(name, direct, options);
  if (options.allowShellFallback !== true) return null;
  if ((options.platform || process.platform) === 'win32') return null;

  const env = options.env || process.env;
  const shell = env.SHELL;
  if (!shell) return null;
  try {
    (options.execFileSyncFn || execFileSync)(
      shell,
      ['-ic', `command -v ${name}`],
      {
        env,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    return writeShellLauncher(name, shell, candidates, options);
  } catch {
    return null;
  }
}
