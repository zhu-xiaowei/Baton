import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  findExecutable,
  installProductionDependencies,
  runExecutable,
  validateProductionDependencies,
} from '../../bridge/platform.mjs';

function dependencyFixture(failing = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpeek-dependencies-'));
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
  const packageJson = {
    name: 'fixture',
    version: '1.0.0',
    dependencies: {
      'fixture-dependency': 'file:./fixture-dependency',
    },
  };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(packageJson));
  fs.copyFileSync(
    new URL('../../bridge/verify-dependencies.mjs', import.meta.url),
    path.join(root, 'verify-dependencies.mjs'),
  );
  const npm = findExecutable('npm');
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
