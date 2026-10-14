import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(
  new URL('../../web/js/project/browser.js', import.meta.url),
  'utf8',
);

test('project files persist their project and directory across a browser refresh', () => {
  assert.match(source, /PROJECT_FILES_VIEW_KEY = 'baton-project-files-view'/);
  assert.match(
    source,
    /savedProjectFilesView = \{[\s\S]*server:[\s\S]*device:[\s\S]*projectHash:[\s\S]*path: currentPath/,
  );
  assert.match(
    source,
    /saved\.device !== state\.appState\.device[\s\S]*saved\.projectHash !== state\.appState\.project\?\.hash/,
  );
  assert.match(source, /openProjectFilesPath\(saved\.path \|\| ''\)/);
  assert.match(
    source,
    /state\.projectFilesOpen = false;\s*saveProjectFilesView\(\);/,
  );
});

test('returning from a file preview refreshes the current directory without clearing it first', () => {
  const viewer = fs.readFileSync(
    new URL('../../web/js/project/file-viewer.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /export async function refreshProjectFiles\(\)/);
  assert.match(source, /deferRender: true/);
  assert.match(source, /var scrollTop = content\.scrollTop/);
  assert.match(source, /content\.scrollTop = Math\.min/);
  assert.doesNotMatch(
    source.match(/export async function refreshProjectFiles\(\)[\s\S]*?\n\}/)?.[0] || '',
    /content\.innerHTML = ''/,
  );
  assert.match(viewer, /if \(wasOpen && options\.refresh !== false\) window\.refreshProjectFiles\?\.\(\)/);
  assert.match(viewer, /closeFileViewer\(\{ refresh: false \}\)/);
});

test('breadcrumb navigation shows cached parent contents before revalidation', () => {
  assert.match(source, /var directoryCache = new Map\(\)/);
  assert.doesNotMatch(source, /DIRECTORY_CACHE_LIMIT/);
  assert.match(source, /readProjectDataCache/);
  assert.match(source, /writeProjectDataCache/);
  assert.match(source, /function rememberDirectoryScroll\(\)/);
  assert.match(
    source,
    /rememberDirectoryScroll\(\);\s*currentPath = normalizeProjectPath\(path\);[\s\S]*?var cached = cachedDirectory\(projectHash, currentPath\)/,
  );
  assert.match(
    source,
    /if \(cached\) \{\s*renderEntries\(cached\.entries\);\s*content\.scrollTop = cached\.scrollTop;/,
  );
  assert.match(source, /deferRender: !!cached/);
  assert.match(source, /if \(!cached\) \{[\s\S]*?Unable to load files/);
  assert.match(source, /if \(persisted\?\.data\?\.entries\)/);
});
