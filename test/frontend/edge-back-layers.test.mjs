import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('file source and previews reuse the shared native edge-back layer', () => {
  const edgeBack = readFileSync(new URL('../../web/js/edge-back.js', import.meta.url), 'utf8');
  const viewer = readFileSync(
    new URL('../../web/js/project/file-viewer.js', import.meta.url),
    'utf8',
  );

  assert.match(edgeBack, /export function registerEdgeBackLayer\(options\)/);
  assert.match(edgeBack, /gestureLayer\.foregroundSelectors/);
  assert.match(edgeBack, /gestureLayer\.navigateBack/);
  assert.match(viewer, /registerEdgeBackLayer\(\{[\s\S]*navigateBack: closeFileViewer,[\s\S]*'#fileOverlay'/);
  assert.match(viewer, /function openFile[\s\S]*_edgeBack\.activate\(\)/);
  assert.match(viewer, /function closeFileViewer\(options\) \{[\s\S]*?_edgeBack\.deactivate\(\)/);
  assert.match(viewer, /function setFileViewMode\(mode\)/);
  assert.match(viewer, /loadingSpinner\(\{ label: 'Loading file' \}\)/);
  assert.doesNotMatch(viewer, /file-loading[^]*class="spinner"/);
  assert.doesNotMatch(viewer, /_edgeBack\.deactivate\(\)[\s\S]*function setFileViewMode/);
});

test('Mermaid fullscreen reuses the shared native edge-back layer', () => {
  const mermaid = readFileSync(
    new URL('../../web/js/components/mermaid.js', import.meta.url),
    'utf8',
  );

  assert.match(mermaid, /window\.registerEdgeBackLayer/);
  assert.match(
    mermaid,
    /window\.registerEdgeBackLayer\(\{[\s\S]*navigateBack: closeMermaidFullscreen,[\s\S]*'\.mermaid-fs-overlay'[\s\S]*guardZIndex: 2002/,
  );
  assert.match(mermaid, /function closeMermaidFullscreen\(\) \{\s*_fsEdgeBack\.deactivate\(\)/);
  assert.match(mermaid, /document\.body\.appendChild\(overlay\);\s*_fsEdgeBack\.activate\(\)/);
});

test('project files use an independent full-screen layer and generic nested edge-back z-index', () => {
  const browser = readFileSync(
    new URL('../../web/js/project/browser.js', import.meta.url),
    'utf8',
  );
  const edgeBack = readFileSync(
    new URL('../../web/js/edge-back.js', import.meta.url),
    'utf8',
  );
  const edgeBackCss = readFileSync(
    new URL('../../web/css/edge-back.css', import.meta.url),
    'utf8',
  );

  assert.match(
    browser,
    /registerEdgeBackLayer\(\{[\s\S]*navigateBack: closeProjectFiles,[\s\S]*foregroundSelectors: \['#projectFilesPage'\],[\s\S]*foregroundZIndex: 900/,
  );
  assert.match(browser, /underlaySelectors: function \(\) \{[\s\S]*return returnToGit \? \['#gitStatusPage'\] : \[\]/);
  assert.doesNotMatch(browser, /getElementById\('(?:content|breadcrumb)'\)/);
  assert.match(
    browser,
    /if \(!keepWs && !state\.wsSessionId\) window\.disconnectWs\?\.\(\)/,
  );
  assert.match(edgeBack, /foregroundZIndex: options\.foregroundZIndex/);
  assert.match(edgeBackCss, /z-index: var\(--edge-back-foreground-z, 301\) !important/);
});

test('Git status and the shared file viewer use two nested edge-back layers', () => {
  const status = readFileSync(
    new URL('../../web/js/git/status.js', import.meta.url),
    'utf8',
  );
  const diff = readFileSync(
    new URL('../../web/js/git/diff-viewer.js', import.meta.url),
    'utf8',
  );
  const viewer = readFileSync(
    new URL('../../web/js/project/file-viewer.js', import.meta.url),
    'utf8',
  );
  assert.match(
    status,
    /registerEdgeBackLayer\(\{[\s\S]*navigateBack: closeGitStatus,[\s\S]*foregroundSelectors: \['#gitStatusPage'\],[\s\S]*foregroundZIndex: 900/,
  );
  assert.match(status, /underlaySelectors: function \(\) \{[\s\S]*return returnToFiles \? \['#projectFilesPage'\] : \[\]/);
  assert.match(
    viewer,
    /registerEdgeBackLayer\(\{[\s\S]*navigateBack: closeFileViewer,[\s\S]*foregroundSelectors: \['#fileOverlay'\],[\s\S]*guardZIndex: 1001/,
  );
  assert.match(diff, /import \{ closeFileViewer, openFile \} from '\.\.\/project\/file-viewer\.js'/);
  const edgeBack = readFileSync(
    new URL('../../web/js/edge-back.js', import.meta.url),
    'utf8',
  );
  assert.match(edgeBack, /\.path-breadcrumb, \.top-bar/);
});
