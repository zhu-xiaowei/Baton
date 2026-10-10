import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../../scripts/release-ios-cloud.mjs', import.meta.url));
const sha = 'a'.repeat(40);
const versionSha = 'b'.repeat(40);
const { privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function dryRun(t, { configured = 40, uploaded = 40, cloud = 40, prepared = false, consumed = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-ios-release-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const apple = path.join(root, 'src-tauri/gen/apple');
  for (const dir of ['scripts', 'bin', 'src-tauri/gen/apple/baton_iOS', '.appstoreconnect/private_keys']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.copyFileSync(source, path.join(root, 'scripts/release-ios-cloud.mjs'));
  fs.writeFileSync(path.join(root, '.appstoreconnect/private_keys/AuthKey_test.p8'), privateKey);
  fs.writeFileSync(path.join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: '1.0.0' }));
  const project = `CFBundleShortVersionString: 1.0.0\nCFBundleVersion: "${configured}"\n`;
  const plist = `<key>CFBundleShortVersionString</key><string>1.0.0</string>
<key>CFBundleVersion</key><string>${configured}</string>`;
  fs.writeFileSync(path.join(apple, 'project.yml'), project);
  fs.writeFileSync(path.join(apple, 'baton_iOS/Info.plist'), plist);
  fs.writeFileSync(path.join(root, 'bin/git'), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'rev-parse') process.stdout.write(args.includes('--abbrev-ref') ? 'release/testflight-next' : '${sha}');
else if (args[0] === 'ls-remote') process.stdout.write('${sha}\\trefs/heads/release/testflight-next');
else if (args[0] === 'blame') process.stdout.write('${versionSha} 1 1 1');
else if (args[0] === 'show') process.stdout.write(${JSON.stringify(prepared ? `chore(ios): bump build number to ${configured}` : 'source changes')});
else if (args[0] === 'merge-base') process.exit(${consumed ? 0 : 1});
else { console.error('Unexpected git mutation: ' + args.join(' ')); process.exit(2); }
`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'mock-api.mjs'), `
import os from 'node:os';
os.homedir = () => ${JSON.stringify(root)};
globalThis.fetch = async (input, options) => {
  if (options.method !== 'GET') throw new Error('Dry run attempted an API mutation');
  const url = new URL(input);
  let response;
  if (url.pathname === '/v1/apps') response = { data: [{ id: 'app' }] };
  else if (url.pathname === '/v1/apps/app/ciProduct') response = { data: { id: 'product' } };
  else if (url.pathname.endsWith('/primaryRepositories')) response = { data: [{ id: 'repo', attributes: { httpCloneUrl: 'https://example.invalid/repo.git' } }] };
  else if (url.pathname === '/v1/builds') response = {
    data: [{ attributes: { version: '${uploaded}' }, relationships: { preReleaseVersion: { data: { id: 'version' } } } }],
    included: [{ id: 'version', attributes: { version: '1.0.0' } }]
  };
  else if (url.pathname.endsWith('/buildRuns')) response = {
    data: [{ attributes: { number: ${cloud}, sourceCommit: { commitSha: '${consumed ? sha : 'c'.repeat(40)}' } } }]
  };
  else throw new Error('Unexpected API request: ' + url);
  return { ok: true, json: async () => response };
};
`);
  const result = spawnSync(process.execPath, [
    '--import', path.join(root, 'mock-api.mjs'),
    path.join(root, 'scripts/release-ios-cloud.mjs'), '--dry-run',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
      APPSTORE_KEY_ID: 'test',
      APPSTORE_ISSUER_ID: 'test',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(apple, 'project.yml'), 'utf8'), project);
  assert.equal(fs.readFileSync(path.join(apple, 'baton_iOS/Info.plist'), 'utf8'), plist);
  return result.stdout;
}

test('a release works without merging the previous build-number commit', (t) => {
  const output = dryRun(t, { configured: 40, uploaded: 41, cloud: 41 });
  assert.match(output, /Next release: 1\.0\.0 \(42\) \(bump both Xcode files\)/);
});

test('failed cloud runs consume numbers even when there is no newer upload', (t) => {
  const output = dryRun(t, { configured: 40, uploaded: 40, cloud: 43 });
  assert.match(output, /Next release: 1\.0\.0 \(44\) \(bump both Xcode files\)/);
});

test('an unused prepared build is reused after a failed push', (t) => {
  const output = dryRun(t, { configured: 41, prepared: true });
  assert.match(output, /Next release: 1\.0\.0 \(41\) \(reuse prepared version\)/);
});

test('a prepared number used by another branch cannot be reused', (t) => {
  const output = dryRun(t, { configured: 41, cloud: 41, prepared: true });
  assert.match(output, /Next release: 1\.0\.0 \(42\) \(bump both Xcode files\)/);
});

test('a consumed prepared commit gets a fresh build number', (t) => {
  const output = dryRun(t, { configured: 41, cloud: 41, prepared: true, consumed: true });
  assert.match(output, /Next release: 1\.0\.0 \(42\) \(bump both Xcode files\)/);
});
