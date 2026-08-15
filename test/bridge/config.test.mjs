import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { loadStoredConfig } from '../../bridge/config.mjs';

test('stored config falls back to a legacy bridge directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-config-'));
  const current = path.join(root, '.baton-bridge', 'config.json');
  const legacy = path.join(root, '.claude-bridge', 'config.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ deviceName: 'legacy-device' }));

  try {
    const stored = loadStoredConfig(current, [legacy]);
    assert.equal(stored.path, legacy);
    assert.equal(stored.config.deviceName, 'legacy-device');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stored config prefers the current bridge directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-config-current-'));
  const current = path.join(root, '.baton-bridge', 'config.json');
  const legacy = path.join(root, '.claude-bridge', 'config.json');
  fs.mkdirSync(path.dirname(current), { recursive: true });
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(current, JSON.stringify({ deviceName: 'current-device' }));
  fs.writeFileSync(legacy, JSON.stringify({ deviceName: 'legacy-device' }));

  try {
    const stored = loadStoredConfig(current, [legacy]);
    assert.equal(stored.path, current);
    assert.equal(stored.config.deviceName, 'current-device');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bridge started without arguments migrates a legacy config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-config-migration-'));
  const legacy = path.join(root, '.claude-bridge', 'config.json');
  const current = path.join(root, '.baton-bridge', 'config.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({
    server: 'https://example.com/v1',
    apiKey: 'test-key',
    deviceName: 'legacy-device',
  }));
  const configModule = new URL('../../bridge/config.mjs', import.meta.url).href;

  try {
    const result = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `const { loadConfig } = await import(${JSON.stringify(configModule)});
       const config = loadConfig();
       process.stdout.write(config.deviceName);`,
    ], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /legacy-device$/);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(current, 'utf-8')),
      JSON.parse(fs.readFileSync(legacy, 'utf-8')),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
