import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  executableOptions,
  findExecutable,
  installProductionDependencies,
  runExecutable,
  validateProductionDependencies,
} from '../../bridge/platform.mjs';

test('Unix child processes inherit the current Node directory on PATH', () => {
  const options = executableOptions('/tmp/codex', {
    env: { PATH: '/usr/bin:/bin' },
  }, {
    platform: 'darwin',
    nodeExecutable: '/Users/test/.nvm/versions/node/v20.20.2/bin/node',
  });

  assert.equal(
    options.env.PATH,
    '/Users/test/.nvm/versions/node/v20.20.2/bin:/usr/bin:/bin',
  );
});

test('child process PATH does not duplicate the current Node directory', () => {
  const nodeDirectory = '/Users/test/.nvm/versions/node/v20.20.2/bin';
  const options = executableOptions('/tmp/codex', {
    env: { PATH: `${nodeDirectory}:/usr/bin:/bin` },
  }, {
    platform: 'darwin',
    nodeExecutable: `${nodeDirectory}/node`,
  });

  assert.equal(options.env.PATH, `${nodeDirectory}:/usr/bin:/bin`);
});

function dependencyFixture(failing = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-dependencies-'));
  const dependency = path.join(root, 'fixture-dependency');
  fs.mkdirSync(dependency);
  fs.writeFileSync(path.join(dependency, 'package.json'), JSON.stringify({
    name: 'fixture-dependency',
    version: '1.0.0',
    main: 'index.js',
  }));
  fs.writeFileSync(
    path.join(dependency, 'index.js'),
    failing ? "throw new Error('native binding unavailable');" : 'module.exports = true;',
  );
  const npm = findExecutable('npm');
  const archive = runExecutable(npm, ['pack', '--silent'], {
    cwd: dependency,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const packageJson = {
    name: 'fixture',
    version: '1.0.0',
    dependencies: {
      'fixture-dependency': `file:./fixture-dependency/${archive}`,
    },
  };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(packageJson));
  fs.copyFileSync(
    new URL('../../bridge/verify-dependencies.mjs', import.meta.url),
    path.join(root, 'verify-dependencies.mjs'),
  );
  runExecutable(npm, [
    'install',
    '--package-lock-only',
    '--ignore-scripts',
    '--silent',
    '--no-audit',
    '--no-fund',
  ], { cwd: root, stdio: 'ignore' });
  return root;
}

test('production dependency validation loads every direct dependency', () => {
  const root = dependencyFixture();
  try {
    installProductionDependencies(root);
    assert.doesNotThrow(() => validateProductionDependencies(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('production installation fails when an installed dependency cannot load', () => {
  const root = dependencyFixture(true);
  try {
    assert.throws(() => installProductionDependencies(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dependency validation rejects a direct dependency resolved from a parent directory', () => {
  const root = dependencyFixture();
  const stage = path.join(root, 'nested-stage');
  try {
    installProductionDependencies(root);
    fs.mkdirSync(stage);
    fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
      name: 'nested-stage',
      version: '1.0.0',
      dependencies: { 'fixture-dependency': '1.0.0' },
    }));
    fs.copyFileSync(
      new URL('../../bridge/verify-dependencies.mjs', import.meta.url),
      path.join(stage, 'verify-dependencies.mjs'),
    );
    assert.throws(() => validateProductionDependencies(stage));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
