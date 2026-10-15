import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const command = fileURLToPath(new URL('../../.github/scripts/rust-cache-command.cjs', import.meta.url));
const run = (args, env = {}) => spawnSync(process.execPath, [command, ...args], {
  env: { ...process.env, ...env },
  encoding: 'utf8',
});

test('cache metadata is online even when the build environment is offline', () => {
  const result = run([process.execPath, '-e', 'process.stdout.write(process.env.CARGO_NET_OFFLINE)'], {
    CARGO_NET_OFFLINE: 'true',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'false');
});

test('cache commands preserve argument boundaries and failure exit codes', () => {
  const result = run([process.execPath, '-e', 'console.log(process.argv[1]); process.exit(7)', 'a b']);
  assert.equal(result.stdout.trim(), 'a b');
  assert.equal(result.status, 7);
});

test('only the selected toolchain contributes to cache toolchain enumeration', () => {
  const result = run(['rustup', 'toolchain', 'list', '--quiet'], {
    RUSTUP_TOOLCHAIN: '1.98.1',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '1.98.1');
});

test('a missing cache command fails rather than silently succeeding', () => {
  const result = run([]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cache command is required/);
});
