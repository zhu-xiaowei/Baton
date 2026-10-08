import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../../scripts/package-cloud.mjs', import.meta.url));
const sha = 'a'.repeat(40);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-package-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'src-tauri'));
  fs.mkdirSync(path.join(root, 'bin'));
  fs.copyFileSync(source, path.join(root, 'scripts/package-cloud.mjs'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  fs.writeFileSync(path.join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: '1.2.3' }));
  const git = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'branch') process.stdout.write('feature/package\\n');
else if (args[0] === 'status') process.stdout.write(process.env.PACKAGE_TEST_DIRTY || '');
else if (args[0] === 'rev-parse') process.stdout.write(process.env.PACKAGE_TEST_SHA);
else if (args[0] === 'ls-remote') process.stdout.write((process.env.PACKAGE_TEST_REMOTE_SHA || process.env.PACKAGE_TEST_SHA) + '\\trefs/heads/feature/package\\n');
else process.exit(2);
`;
  const gh = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const root = process.env.PACKAGE_TEST_DIR;
if (args[0] === 'secret' && args[1] === 'list') {
  process.stdout.write(JSON.stringify(['ANDROID_KEYSTORE_BASE64','MACOS_CERTIFICATE_P12_BASE64','MACOS_CERTIFICATE_PASSWORD','APPLE_SIGNING_IDENTITY','APPLE_ID','APPLE_PASSWORD','APPLE_TEAM_ID'].map(name => ({name}))));
} else if (args[0] === 'workflow' && args[1] === 'run') {
  fs.writeFileSync(path.join(root, 'request-id'), args.find(arg => arg.startsWith('request_id=')).slice(11));
} else if (args[0] === 'run' && args[1] === 'list') {
  process.stdout.write(JSON.stringify([{databaseId: 42, displayTitle: 'Package ' + fs.readFileSync(path.join(root, 'request-id'), 'utf8'), headSha: process.env.PACKAGE_TEST_SHA}]));
} else if (args[0] === 'run' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({status:'completed', conclusion: process.env.PACKAGE_TEST_FAILED_TARGET ? 'failure' : 'success', headSha:process.env.PACKAGE_TEST_SHA, url:'https://github.com/example/run/42', jobs:['Android APK','macOS notarized DMG','Windows NSIS'].map(name => ({name, conclusion: name === process.env.PACKAGE_TEST_FAILED_TARGET ? 'failure' : 'success'}))}));
} else if (args[0] === 'run' && args[1] === 'download') {
  const artifact = args[args.indexOf('--name') + 1];
  const dir = args[args.indexOf('--dir') + 1];
  const file = {'Baton-Android':'Baton.apk','Baton-macOS':'Baton.dmg','Baton-Windows':'Baton.exe'}[artifact];
  fs.writeFileSync(path.join(dir, file), 'fixture-' + file);
} else process.exit(2);
`;
  for (const [name, body] of Object.entries({ git, gh })) {
    const file = path.join(root, 'bin', name);
    fs.writeFileSync(file, body, { mode: 0o755 });
  }
  return root;
}

function run(root, extra = {}, args = []) {
  return spawnSync(process.execPath, [path.join(root, 'scripts/package-cloud.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
      PACKAGE_TEST_DIR: root,
      PACKAGE_TEST_SHA: sha,
      PACKAGE_GITHUB_REPO: 'example/baton',
      ...extra,
    },
  });
}

test('cloud package collects three artifacts from the verified run', (t) => {
  const root = fixture(t);
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  for (const file of ['Baton.apk', 'Baton.dmg', 'Baton.exe']) {
    assert.equal(fs.readFileSync(path.join(root, 'release/1.2.3', file), 'utf8'), `fixture-${file}`);
  }
  assert.match(result.stdout, /SUMMARY \(v1\.2\.3\)/);
});

test('a failed job does not discard successful installers', (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'release/1.2.3'), { recursive: true });
  fs.writeFileSync(path.join(root, 'release/1.2.3/Baton.dmg'), 'stale');
  const result = run(root, { PACKAGE_TEST_FAILED_TARGET: 'macOS notarized DMG' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /macOS: BUILD FAILED \(failure\)/);
  assert.ok(fs.existsSync(path.join(root, 'release/1.2.3/Baton.apk')));
  assert.ok(fs.existsSync(path.join(root, 'release/1.2.3/Baton.exe')));
  assert.ok(!fs.existsSync(path.join(root, 'release/1.2.3/Baton.dmg')));
});

test('unpublished source cannot dispatch a cloud build', (t) => {
  const root = fixture(t);
  const result = run(root, { PACKAGE_TEST_REMOTE_SHA: 'b'.repeat(40) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /push this commit before packaging/);
  assert.ok(!fs.existsSync(path.join(root, 'request-id')));
});

test('dry run checks the source without dispatching', (t) => {
  const root = fixture(t);
  const result = run(root, {}, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dry run/);
  assert.ok(!fs.existsSync(path.join(root, 'request-id')));
});
