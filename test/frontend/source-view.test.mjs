import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import {
  renderSourceView,
  resolveSourceRange,
} from '../../web/js/project/source-view.js';

test('shared source view renders line numbers, highlights, and truncation', () => {
  const dom = new JSDOM('<!doctype html><div id="source"></div>');
  globalThis.window = dom.window;
  const container = dom.window.document.getElementById('source');
  renderSourceView(container, {
    path: 'src/app.js',
    text: 'const first = 1;\nconst second = 2;',
    truncated: true,
    lineHint: '2',
  });
  assert.equal(
    container.querySelector('.file-content code').textContent,
    'const first = 1;\nconst second = 2;',
  );
  assert.equal(container.querySelector('.file-line-hl').textContent, '2');
  assert.ok(container.querySelector('.file-truncated'));
  assert.deepEqual(
    resolveSourceRange('one\ntwo\nthree', '', 'two\nthree'),
    { from: 2, to: 3 },
  );
  dom.window.close();
  delete globalThis.window;
});

test('Git Code reuses the complete file viewer and its source renderer', () => {
  const diff = fs.readFileSync(
    new URL('../../web/js/git/diff-viewer.js', import.meta.url),
    'utf8',
  );
  const viewer = fs.readFileSync(
    new URL('../../web/js/project/file-viewer.js', import.meta.url),
    'utf8',
  );
  assert.match(diff, /import \{ closeFileViewer, openFile \} from '\.\.\/project\/file-viewer\.js'/);
  assert.match(viewer, /import \{ renderSourceView \} from '\.\/source-view\.js'/);
  assert.match(diff, /openFile\(path, path\.split\('\/'\)\.pop\(\),/);
  assert.match(viewer, /renderSourceView\(body,/);
  assert.doesNotMatch(diff, /git-full-code/);
});
