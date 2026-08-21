import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TEST_ROOT = path.join(ROOT, 'test');
const SKIP_DIRS = new Set([
  '.git',
  '.build',
  '.pytest_cache',
  'dist',
  'gen',
  'node_modules',
  'release',
  'target',
]);

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function repositoryFiles(directory = ROOT) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...repositoryFiles(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

function isTestFile(filePath) {
  const relative = path.relative(ROOT, filePath);
  const parts = relative.split(path.sep);
  const name = parts.at(-1);
  return parts.some((part) => ['test', 'tests', '__tests__'].includes(part))
    || /^test_.*\.py$/i.test(name)
    || /_test\.py$/i.test(name)
    || /\.(test|spec)\.[^.]+$/i.test(name);
}

test('repository-owned tests only live under the top-level test directory', () => {
  const misplaced = repositoryFiles()
    .filter(isTestFile)
    .filter((filePath) => !filePath.startsWith(`${TEST_ROOT}${path.sep}`))
    .map((filePath) => path.relative(ROOT, filePath));
  assert.deepEqual(misplaced, []);
});

test('Bridge and Server packaging use explicit production-only inputs', () => {
  const install = read('server/install.sh');
  assert.match(
    install,
    /cp "\$BRIDGE_DIR"\/\*\.mjs "\$BRIDGE_DIR\/package\.json" "\$BRIDGE_DIR\/package-lock\.json" "\$BRIDGE_STAGE\/"/,
  );
  assert.match(install, /tar czf "\$BRIDGE_TAR" \*\.mjs package\.json package-lock\.json/);
  assert.doesNotMatch(install, /cp\s+-r\s+"\$BRIDGE_DIR"/);
  assert.doesNotMatch(install, /cp\s+-r\s+"\$ROOT_DIR"/);
  const bridgeUpload = install.indexOf('aws s3 cp "$BRIDGE_TAR"');
  assert.ok(bridgeUpload > -1);
  assert.ok(bridgeUpload < install.indexOf('aws cloudformation create-stack'));
  assert.ok(bridgeUpload < install.indexOf('aws cloudformation update-stack'));

  const dockerfile = read('server/src/Dockerfile');
  assert.doesNotMatch(dockerfile, /^\s*COPY\s+\.\s/m);
  assert.match(dockerfile, /^COPY web\/ web\/$/m);
  assert.match(dockerfile, /^COPY --from=web-builder \/build\/dist web\/$/m);
});

test('Sessions table declares the root-thread lookup index', () => {
  const template = JSON.parse(read('server/template/Baton.template'));
  const table = template.Resources.BridgeSessionsTable.Properties;
  const attributes = new Set(table.AttributeDefinitions.map((item) => item.AttributeName));
  assert.equal(attributes.has('threadRootPk'), true);
  assert.equal(attributes.has('threadRootSk'), true);

  const index = table.GlobalSecondaryIndexes.find(
    (item) => item.IndexName === 'threadRootPk-threadRootSk-index',
  );
  assert.deepEqual(index.KeySchema, [
    { AttributeName: 'threadRootPk', KeyType: 'HASH' },
    { AttributeName: 'threadRootSk', KeyType: 'RANGE' },
  ]);
  assert.equal(index.Projection.ProjectionType, 'ALL');
});

test('web and Tauri builds consume web sources and dist only', () => {
  const vite = read('vite.config.js');
  assert.match(vite, /root:\s*['"]web['"]/);
  assert.match(vite, /outDir:\s*['"]\.\.\/dist['"]/);

  const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
  assert.equal(tauri.build.frontendDist, '../dist');
  assert.equal(tauri.build.beforeBuildCommand, 'npm run build');
});

test('current production source sets contain no test files', () => {
  const bridgePackage = fs.readdirSync(path.join(ROOT, 'bridge'))
    .filter((name) => name.endsWith('.mjs') || ['package.json', 'package-lock.json'].includes(name));
  assert.equal(bridgePackage.some((name) => isTestFile(path.join(ROOT, 'bridge', name))), false);

  for (const sourceRoot of ['server/src', 'web', 'dist']) {
    const absolute = path.join(ROOT, sourceRoot);
    if (!fs.existsSync(absolute)) continue;
    const packagedTests = repositoryFiles(absolute)
      .filter(isTestFile)
      .map((filePath) => path.relative(ROOT, filePath));
    assert.deepEqual(packagedTests, []);
  }
});
