import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const bridgePackageUrl = new URL('../../bridge/package.json', import.meta.url);
const bridgeRequire = createRequire(bridgePackageUrl);
const ptyPackagePath = bridgeRequire.resolve('node-pty/package.json');
const ptyDirectory = path.dirname(ptyPackagePath);

test('Bridge pins the tested PTY release in both manifests and installed dependencies', () => {
  const bridgePackage = JSON.parse(fs.readFileSync(bridgePackageUrl, 'utf8'));
  const lock = JSON.parse(fs.readFileSync(new URL('../../bridge/package-lock.json', import.meta.url), 'utf8'));
  const ptyPackage = JSON.parse(fs.readFileSync(ptyPackagePath, 'utf8'));
  const version = bridgePackage.dependencies['node-pty'];

  assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
  assert.equal(lock.packages[''].dependencies['node-pty'], version);
  assert.equal(lock.packages['node_modules/node-pty'].version, version);
  assert.equal(ptyPackage.version, version);
});

test('PTY release includes native binaries for every supported desktop platform', () => {
  const platforms = {
    'linux-arm64': ['pty.node'],
    'linux-x64': ['pty.node'],
    'darwin-arm64': ['pty.node', 'spawn-helper'],
    'darwin-x64': ['pty.node', 'spawn-helper'],
    'win32-arm64': ['conpty.node', 'conpty_console_list.node'],
    'win32-x64': ['conpty.node', 'conpty_console_list.node'],
  };

  for (const [platform, binaries] of Object.entries(platforms)) {
    for (const binary of binaries) {
      assert.ok(
        fs.existsSync(path.join(ptyDirectory, 'prebuilds', platform, binary)),
        `${platform}/${binary} must ship prebuilt, without requiring a host compiler`,
      );
    }
  }
});
