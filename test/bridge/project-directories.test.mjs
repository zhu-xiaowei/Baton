import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { handleProjectFilesMessage } from '../../bridge/project/files.mjs';
import { createProjectDirectory, resolveProjectPath } from '../../bridge/project-path.mjs';
import { projectHashToPath } from '../../bridge/session.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-directories-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home };
}

async function browse(home, requestedPath = '', cursor) {
  const messages = [];
  await handleProjectFilesMessage({
    action: 'project_files', operation: 'browse', requestId: 'browse',
    path: requestedPath, cursor, replyConnectionId: 'app',
  }, { homeDir: home, send: message => messages.push(message) });
  return messages[0];
}

test('directory picker starts at the device home and lists only folders including hidden folders', async t => {
  const { home } = fixture(t);
  for (const name of ['folder10', 'folder2', '.hidden']) fs.mkdirSync(path.join(home, name));
  fs.writeFileSync(path.join(home, 'file.txt'), '');
  const response = await browse(home);
  assert.equal(response.ok, true);
  assert.equal(response.path, home);
  assert.equal(response.targetPath, home);
  assert.equal(response.parentPath, path.dirname(home));
  assert.equal(response.replyConnectionId, 'app');
  assert.equal(response.exists, true);
  assert.deepEqual(response.entries.map(entry => entry.name), ['.hidden', 'folder2', 'folder10']);
});

test('directory browsing supports paths outside home and previews a new leaf without creating it', async t => {
  const { root, home } = fixture(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  const target = path.join(outside, 'new-project');
  const response = await browse(home, target);
  assert.equal(response.ok, true);
  assert.equal(response.path, outside);
  assert.equal(response.parentPath, outside);
  assert.equal(response.targetPath, target);
  assert.equal(response.exists, false);
  assert.equal(fs.existsSync(target), false);
  assert.equal((await browse(home, path.join(target, 'missing-parent'))).ok, false);
  fs.writeFileSync(path.join(home, 'file'), '');
  assert.equal((await browse(home, 'file')).ok, false);
  const rootResponse = await browse(home, path.parse(home).root);
  assert.equal(rootResponse.parentPath, rootResponse.targetPath);
});

test('directory pagination filters files before paging and keeps all folders reachable', async t => {
  const { home } = fixture(t);
  for (let index = 0; index < 220; index++) {
    fs.mkdirSync(path.join(home, 'folder' + index));
    fs.writeFileSync(path.join(home, 'file' + index), '');
  }
  const first = await browse(home);
  const second = await browse(home, '', first.nextCursor);
  assert.equal(first.entries.length, 200);
  assert.equal(second.entries.length, 20);
  assert.equal(second.nextCursor, undefined);
  assert.equal(new Set([...first.entries, ...second.entries].map(entry => entry.name)).size, 220);
});

test('path resolution and creation agree for relative, tilde, and external absolute paths', t => {
  const { root, home } = fixture(t);
  for (const [input, expected] of [
    ['project', path.join(home, 'project')],
    ['~/tilde', path.join(home, 'tilde')],
    [path.join(root, 'external'), path.join(root, 'external')],
  ]) {
    assert.equal(resolveProjectPath(input, home), expected);
    const created = createProjectDirectory(input, home);
    const realPath = fs.realpathSync.native(expected);
    assert.equal(created.projectPath, realPath);
    assert.equal(created.projectName, path.basename(expected));
    assert.equal(created.projectHash, realPath.replace(/[^a-zA-Z0-9-]/g, '-'));
    assert.equal(fs.statSync(expected).isDirectory(), true);
    assert.deepEqual(createProjectDirectory(input, home), created);
  }
  assert.equal(resolveProjectPath('~', home), home);
  assert.throws(() => resolveProjectPath('bad\0path', home), /Invalid path/);
  assert.throws(() => createProjectDirectory('', home), /empty/);
});

test('projects created through a symlink resolve to the real directory for the first session', async t => {
  const { root, home } = fixture(t);
  const real = path.join(root, 'real');
  const alias = path.join(root, 'alias');
  fs.mkdirSync(real);
  fs.symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const selected = path.join(alias, 'project');
  const preview = await browse(home, selected);
  assert.equal(preview.exists, false);
  const created = createProjectDirectory(selected, home);
  const canonical = fs.realpathSync.native(selected);
  assert.equal(created.projectPath, canonical);
  assert.equal(created.projectHash, canonical.replace(/[^a-zA-Z0-9-]/g, '-'));
  fs.writeFileSync(path.join(canonical, 'session-marker.txt'), 'correct project');
  const sessionPath = projectHashToPath(created.projectHash);
  assert.equal(fs.realpathSync.native(sessionPath), canonical);
  assert.equal(fs.readFileSync(path.join(sessionPath, 'session-marker.txt'), 'utf8'), 'correct project');
});

test('selecting an existing symlink uses its target hash and keeps the selected display name', t => {
  const { root, home } = fixture(t);
  const target = path.join(root, 'actual-project');
  const selected = path.join(home, 'project-shortcut');
  fs.mkdirSync(target);
  fs.symlinkSync(target, selected, process.platform === 'win32' ? 'junction' : 'dir');
  const created = createProjectDirectory(selected, home);
  assert.equal(created.projectName, 'project-shortcut');
  assert.equal(created.projectHash, createProjectDirectory(target, home).projectHash);
  assert.equal(fs.realpathSync.native(projectHashToPath(created.projectHash)), fs.realpathSync.native(target));
});
