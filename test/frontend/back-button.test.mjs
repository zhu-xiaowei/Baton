import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  BACK_ICON_SVG,
  backButtonHtml,
} from '../../web/js/components/back-button.js';

test('page headers share a back button and Git diff reuses file viewer navigation', () => {
  assert.match(BACK_ICON_SVG, /m15 6-6 6 6 6/);
  assert.match(backButtonHtml(), /class="back-button"/);

  const breadcrumb = fs.readFileSync(
    new URL('../../web/js/components/breadcrumb.js', import.meta.url),
    'utf8',
  );
  const setupEntry = fs.readFileSync(
    new URL('../../web/js/entry-setup.js', import.meta.url),
    'utf8',
  );
  const setupHtml = fs.readFileSync(
    new URL('../../web/setup.html', import.meta.url),
    'utf8',
  );
  const gitPage = fs.readFileSync(
    new URL('../../web/js/git/page.js', import.meta.url),
    'utf8',
  );
  const gitDiff = fs.readFileSync(
    new URL('../../web/js/git/diff-viewer.js', import.meta.url),
    'utf8',
  );

  assert.match(breadcrumb, /backButtonHtml\(\{ className: 'path-breadcrumb-back' \}\)/);
  assert.match(setupEntry, /mountBackButton\(document\.getElementById\('setupBackButton'\), leaveSetup\)/);
  assert.match(setupEntry, /attachPageEdgeBackGesture\(leaveSetup,/);
  assert.match(gitPage, /backButtonHtml\(\{ className: 'git-status-back' \}\)/);
  assert.match(gitDiff, /import \{ closeFileViewer, openFile \} from '\.\.\/project\/file-viewer\.js'/);
  assert.doesNotMatch(gitDiff, /aria-label="Back">‹/);
  assert.doesNotMatch(setupHtml, /class="back"/);
  assert.doesNotMatch(setupHtml, /<polyline points="15 18 9 12 15 6"/);

  const css = fs.readFileSync(
    new URL('../../web/css/back-button.css', import.meta.url),
    'utf8',
  );
  assert.match(css, /\.back-button::before \{[\s\S]*?left: -8px;[\s\S]*?width: 36px;[\s\S]*?height: 44px;/);
  assert.match(css, /\.back-button svg \{[\s\S]*?pointer-events: none;/);
  assert.match(css, /\.back-button:active,[\s\S]*?\.back-button\.edge-back-tap-active/);
  assert.match(css, /@media \(hover: none\), \(pointer: coarse\) \{[\s\S]*?background: transparent;/);
});
