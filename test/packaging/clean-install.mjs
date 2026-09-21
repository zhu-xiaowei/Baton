import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [stageArgument, installerArgument] = process.argv.slice(2);
assert.ok(stageArgument, 'Usage: node clean-install.mjs <staged-bridge> [legacy-platform.mjs]');
assert.equal(process.platform, 'linux', 'Run this test in a clean Linux container');

for (const tool of ['make', 'gcc', 'g++', 'python3']) {
  const result = spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', tool]);
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, `${tool} must be absent to reproduce a compiler-free host`);
}

const stage = path.resolve(stageArgument);
const installer = path.resolve(installerArgument || path.join(stage, 'platform.mjs'));
const { installProductionDependencies } = await import(pathToFileURL(installer));
installProductionDependencies(stage);

const bridgeRequire = createRequire(path.join(stage, 'package.json'));
const pty = bridgeRequire('node-pty');
await new Promise((resolve, reject) => {
  let output = '';
  let sent = false;
  const terminal = pty.spawn('/bin/sh', [
    '-c',
    'printf "PTY_READY\\n"; read reply; printf "PTY_ECHO:%s\\n" "$reply"',
  ], { cols: 80, rows: 24, cwd: stage, env: process.env });
  const timeout = setTimeout(() => {
    terminal.kill();
    reject(new Error('PTY input/output verification timed out'));
  }, 10000);
  terminal.onData((data) => {
    output += data;
    if (!sent && output.includes('PTY_READY')) {
      sent = true;
      terminal.resize(100, 32);
      terminal.write('baton-update-smoke\n');
    }
  });
  terminal.onExit(({ exitCode }) => {
    clearTimeout(timeout);
    try {
      assert.equal(exitCode, 0);
      assert.ok(output.includes('PTY_ECHO:baton-update-smoke'), output);
      resolve();
    } catch (error) {
      reject(error);
    }
  });
});

console.log(`PASS: compiler-free ${process.platform}/${process.arch} install, dependency validation, PTY input/output and resize`);
