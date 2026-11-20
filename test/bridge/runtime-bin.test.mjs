import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('CLI lookup: an older nvm version, the nvm default, and a CLI installed later', { skip: process.platform === 'win32' }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-rtbin-'));
  Object.assign(process.env, { HOME: home, PATH: '/usr/bin:/bin', SHELL: '/bin/false' });
  delete process.env.NVM_DIR;
  const write = (file, text = '#!/bin/sh\necho 1.0.0\n') => {
    fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
    fs.writeFileSync(path.join(home, file), text, { mode: 0o755 });
    return path.join(home, file);
  };
  write('.nvm/versions/node/v22.21.0/bin/node');
  const codex = write('.nvm/versions/node/v20.19.4/bin/codex');
  const { cachedRuntimeBin, findRuntimeBin, forgetRuntimeBin } = await import('../../bridge/runtime-bin.mjs');
  assert.equal(findRuntimeBin('codex').bin, codex);
  write('.nvm/versions/node/v22.21.0/bin/codex');
  write('.nvm/alias/default', '20\n');
  assert.equal(findRuntimeBin('codex').bin, codex);
  assert.equal(cachedRuntimeBin('baton-test-cli'), null);
  const later = write('.local/bin/baton-test-cli');
  assert.equal(cachedRuntimeBin('baton-test-cli'), null);
  forgetRuntimeBin('baton-test-cli');
  assert.equal(cachedRuntimeBin('baton-test-cli'), later);
  fs.rmSync(home, { recursive: true, force: true });
});
