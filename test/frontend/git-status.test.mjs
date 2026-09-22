import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { state } from '../../web/js/state.js';
import { requestGit } from '../../web/js/git/rpc.js';
import { renderGitStatus } from '../../web/js/git/status-render.js';
import {
  GIT_DIFF_VIEW_KEY,
  GIT_STATUS_VIEW_KEY,
  clearGitDiffView,
  clearGitStatusView,
  readGitDiffView,
  saveGitDiffView,
  saveGitStatusView,
  shouldRestoreGitStatus,
} from '../../web/js/git/view-state.js';
import { handleWsRpcMessage } from '../../web/js/ws-rpc.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('Git RPC assembles out-of-order grouped snapshot frames', async () => {
  var payload;
  globalThis.window = {
    wsSendReliable(value) { payload = value; },
  };
  state.appState.device = 'Mac';
  var pending = requestGit('status', { projectHash: 'project' });
  handleWsRpcMessage({
    action: 'git_status',
    operation: 'status',
    requestId: payload.requestId,
    ok: true,
    sequence: 1,
    chunkCount: 2,
    complete: true,
    snapshotId: 'snapshot',
    groups: { conflicts: [], staged: [], changes: [{ path: 'b.js', status: 'untracked' }] },
  });
  handleWsRpcMessage({
    action: 'git_status',
    operation: 'status',
    requestId: payload.requestId,
    ok: true,
    sequence: 0,
    chunkCount: 2,
    complete: false,
    snapshotId: 'snapshot',
    groups: { conflicts: [], staged: [{ path: 'a.js', status: 'modified' }], changes: [] },
  });
  var result = await pending;
  assert.equal(result.groups.staged[0].path, 'a.js');
  assert.equal(result.groups.changes[0].path, 'b.js');
  delete globalThis.window;
});

test('Git renderer hides empty optional sections and always shows Changes', () => {
  const dom = new JSDOM('<!doctype html><div id="content"></div>');
  globalThis.document = dom.window.document;
  var content = document.getElementById('content');
  renderGitStatus(content, {
    groups: { conflicts: [], staged: [], changes: [] },
  });
  assert.equal(content.querySelector('[data-group="conflicts"]'), null);
  assert.equal(content.querySelector('[data-group="staged"]'), null);
  assert.ok(content.querySelector('[data-group="changes"]'));
  assert.equal(content.querySelector('.git-count'), null);
  assert.equal(content.querySelector('.git-action'), null);
  dom.window.close();
  delete globalThis.document;
});

test('Git renderer exposes row and Section operations without opening Diff', () => {
  const dom = new JSDOM('<!doctype html><div id="content"></div>');
  globalThis.document = dom.window.document;
  var mutations = [];
  var diffs = [];
  var content = document.getElementById('content');
  renderGitStatus(content, {
    groups: {
      conflicts: [{ path: 'conflict.js', status: 'conflicted' }],
      staged: [{ path: 'staged.js', status: 'modified' }],
      changes: [{ path: 'src/app.js', status: 'modified' }],
    },
  }, {
    collapsed: new Set(),
    onMutation(value) { mutations.push(value); },
    onDiff(pathValue, group) { diffs.push({ path: pathValue, group }); },
  });
  content.querySelector('.git-file-row[data-path="src/app.js"] .git-action[data-operation="stage"]').click();
  assert.deepEqual(mutations[0], {
    operation: 'stage',
    group: 'changes',
    path: 'src/app.js',
  });
  assert.deepEqual(diffs, []);
  content.querySelector('.git-file-row[data-path="src/app.js"] .git-file-main').click();
  assert.deepEqual(diffs[0], { path: 'src/app.js', group: 'changes' });
  content.querySelector('.git-section[data-group="changes"] .git-section-actions [data-operation="discard"]').click();
  assert.deepEqual(mutations[1], {
    operation: 'discard',
    group: 'changes',
    path: '',
  });
  dom.window.close();
  delete globalThis.document;
});

test('Git Section toggle owns the full left side of its Header', () => {
  const css = fs.readFileSync(path.join(ROOT, 'web/css/git-status.css'), 'utf8');
  assert.match(css, /\.git-section-header\{[^}]*position:sticky;[^}]*top:0;[^}]*z-index:3;[^}]*padding:0;[^}]*background:#1c2128/);
  assert.doesNotMatch(css, /\.git-section-header\{[^}]*box-shadow:/);
  assert.match(css, /\.git-section-toggle\{[^}]*padding:0 0 0 10px/);
  const toggleBase = css.indexOf('.git-section-toggle{min-width:0');
  const toggleDesktop = css.indexOf('@media(hover:hover) and (pointer:fine){.git-section-toggle{padding-left:12px}}');
  assert.ok(toggleDesktop > toggleBase);
  assert.match(css, /\.git-section-toggle svg\{[^}]*pointer-events:none/);
});

test('Git file rows keep the filename, directory, status, and actions on one compact line', () => {
  const dom = new JSDOM('<!doctype html><div id="content"></div>');
  globalThis.document = dom.window.document;
  const content = document.getElementById('content');
  renderGitStatus(content, {
    groups: {
      conflicts: [],
      staged: [],
      changes: [{ path: 'src/components/App.js', status: 'modified' }],
    },
  });
  const copy = content.querySelector('.git-file-copy');
  assert.equal(copy.querySelector('.git-file-name').textContent, 'App.js');
  assert.equal(copy.querySelector('.git-file-directory').textContent, 'src/components');
  assert.equal(copy.children[0].className, 'git-file-name');
  assert.equal(copy.children[1].className, 'git-file-directory');

  const css = fs.readFileSync(path.join(ROOT, 'web/css/git-status.css'), 'utf8');
  assert.match(css, /\.git-file-row\{[^}]*min-height:40px/);
  assert.match(css, /\.git-row-actions \.git-action\{height:40px\}/);
  assert.match(css, /\.git-file-copy\{[^}]*display:flex;[^}]*align-items:baseline;[^}]*overflow:hidden/);
  assert.match(css, /\.git-file-name\{[^}]*flex:0 0 auto/);
  assert.match(css, /\.git-file-directory\{[^}]*min-width:0;[^}]*flex:1;[^}]*text-overflow:ellipsis/);
  assert.match(css, /\.git-section-actions,\.git-row-actions\{[^}]*flex:0 0 auto\}/);
  assert.match(css, /html\.native-mobile \.git-section-actions,html\.native-mobile \.git-row-actions\{margin-right:4px\}/);
  assert.match(css, /\.git-action\{width:36px;[^}]*justify-content:center/);
  assert.doesNotMatch(css, /git-action:first-child:nth-last-child\(2\) svg/);
  assert.match(css, /\.git-action\[data-operation="discard"\] svg\{transform:translateX\(2px\)\}/);
  assert.match(css, /\.git-action\[data-operation="stage"\] svg,[\s\S]*?\.git-action\[data-operation="unstage"\] svg\{transform:translateX\(-2px\)\}/);
  assert.match(css, /\.git-status-content\{[^}]*overflow-x:hidden;overflow-y:auto/);
  assert.match(css, /@media\(hover:hover\) and \(pointer:fine\)\{[\s\S]*?\.git-status-content\{scrollbar-gutter:stable\}[\s\S]*?\.git-section-header::after\{[^}]*left:100%;[^}]*width:24px;[^}]*background:#1c2128/);
  assert.match(css, /\.git-section\{border-bottom:1px solid #30363d\}/);
  dom.window.close();
  delete globalThis.document;
});

test('Session detail adds Git before runtime and keeps Project Files separate', () => {
  const app = fs.readFileSync(path.join(ROOT, 'web/js/app.js'), 'utf8');
  const project = fs.readFileSync(path.join(ROOT, 'web/js/project/browser.js'), 'utf8');
  assert.match(app, /topRight\.innerHTML = gitButton \+ runtimeMark \+ filesButton/);
  assert.match(app, /onclick="openGitStatusPage\(\)"/);
  assert.match(project, /deactivateProjectFiles\(true\);[\s\S]*?openGitStatusPage/);
});

test('Git page header is static text instead of a clickable breadcrumb', () => {
  const page = fs.readFileSync(path.join(ROOT, 'web/js/git/page.js'), 'utf8');
  assert.match(page, /git-status-project/);
  assert.match(page, /git-status-title">Git Changes/);
  assert.match(page, /button class="path-breadcrumb-item git-status-project"/);
  assert.match(page, /aria-label="Refresh Git changes"/);
  assert.match(page, /setBreadcrumbItemsLoading\(\[projectLabel\]/);
  assert.doesNotMatch(page, /git-status-separator/);
  assert.doesNotMatch(page, /createBreadcrumb/);
});

test('Git sections start expanded every time the page opens', () => {
  const status = fs.readFileSync(path.join(ROOT, 'web/js/git/status.js'), 'utf8');
  assert.match(status, /export function openGitStatus\(options\)[\s\S]*?collapsed = new Set\(\);/);
  assert.doesNotMatch(status, /baton-git-sections|sessionStorage/);
  assert.doesNotMatch(status, /saveCollapsed|restoreCollapsed/);
});

test('Git mutations animate the project label while actions are disabled', () => {
  const status = fs.readFileSync(path.join(ROOT, 'web/js/git/status.js'), 'utf8');
  assert.match(status, /busy = true;\s*setGitLoading\(true\);\s*render\(\);/);
  assert.match(status, /finally \{\s*busy = false;\s*setGitLoading\(false\);\s*render\(\);/);
});

test('Git page view state survives refresh only for the same session', () => {
  const values = new Map();
  const storage = {
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
  const appState = {
    device: 'Mac',
    project: { hash: 'project' },
    session: 'session',
  };
  saveGitStatusView(appState, storage);
  assert.ok(values.has(GIT_STATUS_VIEW_KEY));
  assert.equal(shouldRestoreGitStatus(appState, storage), true);
  assert.equal(shouldRestoreGitStatus({ ...appState, session: 'other' }, storage), false);
  assert.equal(values.has(GIT_STATUS_VIEW_KEY), false);
  saveGitStatusView(appState, storage);
  clearGitStatusView(storage);
  assert.equal(values.has(GIT_STATUS_VIEW_KEY), false);

  const app = fs.readFileSync(path.join(ROOT, 'web/js/app.js'), 'utf8');
  const status = fs.readFileSync(path.join(ROOT, 'web/js/git/status.js'), 'utf8');
  assert.match(app, /if \(options\.restoreGitStatus\) openGitStatusPage\(\{ restoring: true \}\)/);
  assert.match(status, /state\.gitStatusOpen = true;\s*saveGitStatusView\(state\.appState\)/);
  assert.match(status, /state\.gitStatusOpen = false;\s*closeGitDiff\(\);\s*clearGitStatusView\(\)/);
});

test('Git Diff and Code mode survive refresh for the same session', () => {
  const values = new Map();
  const storage = {
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
  const appState = {
    device: 'Mac',
    project: { hash: 'project' },
    session: 'session',
  };
  saveGitDiffView(appState, {
    path: 'src/app.js',
    group: 'changes',
    status: 'modified',
    mode: 'code',
  }, storage);
  assert.ok(values.has(GIT_DIFF_VIEW_KEY));
  assert.deepEqual(readGitDiffView(appState, storage), {
    path: 'src/app.js',
    group: 'changes',
    status: 'modified',
    mode: 'code',
  });
  assert.equal(readGitDiffView({ ...appState, session: 'other' }, storage), null);
  assert.equal(values.has(GIT_DIFF_VIEW_KEY), false);
  saveGitDiffView(appState, { path: 'src/app.js', group: 'changes' }, storage);
  clearGitDiffView(storage);
  assert.equal(values.has(GIT_DIFF_VIEW_KEY), false);

  const diff = fs.readFileSync(path.join(ROOT, 'web/js/git/diff-viewer.js'), 'utf8');
  const status = fs.readFileSync(path.join(ROOT, 'web/js/git/status.js'), 'utf8');
  assert.match(diff, /view\.mode = mode === 'diff' \? 'diff' : 'code';\s*saveGitDiffView\(state\.appState, view\)/);
  assert.match(diff, /export function restoreGitDiffView\(\)/);
  assert.match(diff, /clearGitDiffView\(\);\s*if \(!current\) return false;\s*return closeFileViewer\(\)/);
  assert.match(diff, /if \(closeOptions\.refresh !== false && state\.gitStatusOpen\) window\.refreshGitStatus\?\.\(\)/);
  assert.match(status, /window\.connectWs\(\);\s*restoreGitDiffView\(\);\s*refreshGitStatus\(\)/);
  assert.match(status, /state\.gitStatusOpen = false;\s*closeGitDiff\(\);\s*clearGitStatusView\(\)/);
});

test('Workspace Header actions match top-bar height without growing desktop headers', () => {
  const css = fs.readFileSync(path.join(ROOT, 'web/css/git-status.css'), 'utf8');
  const workspaceCss = fs.readFileSync(path.join(ROOT, 'web/css/workspace-header.css'), 'utf8');
  const style = fs.readFileSync(path.join(ROOT, 'web/css/style.css'), 'utf8');
  assert.match(workspaceCss, /\.workspace-switch \{[\s\S]*?width: 28px;[\s\S]*?height: 28px;[\s\S]*?flex: 0 0 28px;/);
  assert.match(workspaceCss, /html\.native-mobile \.workspace-switch \{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/);
  assert.match(workspaceCss, /\.workspace-switch svg\.git-branch-icon \{[\s\S]*?width: 20px;/);
  assert.match(workspaceCss, /@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\.git-status-header > \.workspace-switch \{[\s\S]*?margin-right: 2px;/);
  assert.match(workspaceCss, /html\.native-mobile \.workspace-switch svg\.git-branch-icon \{[\s\S]*?width: 22px;/);
  assert.match(workspaceCss, /html\.native-mobile \.project-files-page-breadcrumb,[\s\S]*?html\.native-mobile \.git-status-header,[\s\S]*?html\.native-mobile \.project-terminal-header \{[\s\S]*?padding-left: 2px;[\s\S]*?padding-right: 2px;/);
  assert.match(workspaceCss, /html\.native-mobile \.project-files-page-breadcrumb > \.back-button,[\s\S]*?html\.native-mobile \.git-status-header > \.back-button,[\s\S]*?html\.native-mobile \.project-terminal-header > \.back-button \{[\s\S]*?width: 32px;[\s\S]*?flex-basis: 32px;[\s\S]*?margin-right: 8px;/);
  assert.match(workspaceCss, /html\.native-mobile \.project-files-page-breadcrumb > \.back-button::before,[\s\S]*?html\.native-mobile \.git-status-header > \.back-button::before,[\s\S]*?html\.native-mobile \.project-terminal-header > \.back-button::before \{[\s\S]*?left: -4px;[\s\S]*?width: 36px;/);
  assert.match(workspaceCss, /html\.native-mobile \.project-files-page-breadcrumb > \.back-button svg,[\s\S]*?html\.native-mobile \.git-status-header > \.back-button svg,[\s\S]*?html\.native-mobile \.project-terminal-header > \.back-button svg \{[\s\S]*?transform: translateX\(2px\);/);
  assert.match(css, /\.project-files-entry\.git-status-entry svg\.git-branch-icon\{width:20px;height:20px/);
  assert.match(css, /html\.native-mobile #top-right \.project-files-entry\.git-status-entry svg\.git-branch-icon,html\.native-mobile \.edge-back-top-right \.project-files-entry\.git-status-entry svg\.git-branch-icon\{width:22px;height:22px;transform:translate\(calc\(-50% \+ 2px\),-50%\)/);
  assert.match(style, /\.runtime-mark-codex::before \{[\s\S]*?width: 16px; height: 16px;/);
  assert.match(style, /\.runtime-mark-codex::before \{[\s\S]*?background: #6e7681;/);
  assert.match(style, /html\.native-mobile #top-right \.runtime-mark-codex::before,[\s\S]*?width: 24px; height: 24px;/);
  assert.doesNotMatch(style, /html\.native-mobile #top-right \.runtime-icon\s*\{[^}]*translateX\(3px\)/);
  assert.doesNotMatch(style, /\.runtime-mark-codex\s*\{[^}]*color:/);
  assert.match(css, /\.git-status-heading\{[^}]*padding-left:0/);
  assert.doesNotMatch(css, /git-status-header>\.back-button\{/);
  assert.doesNotMatch(css, /git-status-header \.back-button::/);
  assert.doesNotMatch(css, /git-status-header \.back-button[^{}]*\{[^}]*background:/);
  assert.match(css, /\.git-section-header\{[^}]*padding:0;/);
});

test('Diff back consumes Escape before Git page can close', () => {
  const diff = fs.readFileSync(path.join(ROOT, 'web/js/git/diff-viewer.js'), 'utf8');
  const viewer = fs.readFileSync(path.join(ROOT, 'web/js/project/file-viewer.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
  const style = fs.readFileSync(path.join(ROOT, 'web/css/style.css'), 'utf8');
  const page = fs.readFileSync(path.join(ROOT, 'web/js/git/page.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'web/css/git-status.css'), 'utf8');
  assert.match(diff, /import \{ closeFileViewer, openFile \} from '\.\.\/project\/file-viewer\.js'/);
  assert.doesNotMatch(diff, /createElement|addEventListener|renderSourceView/);
  assert.match(viewer, /stopImmediatePropagation\(\)/);
  assert.match(viewer, /\}, true\);/);
  assert.match(html, /id="fileOverlayTabs" class="file-tabs"/);
  assert.match(html, /class="file-tab" data-mode="diff"/);
  assert.match(viewer, /import \{ loadingSpinner \} from '\.\.\/components\/loading\.js'/);
  assert.match(viewer, /loadingSpinner\(\{ label: 'Loading diff' \}\)/);
  assert.match(viewer, /loadingSpinner\(\{ label: 'Loading file' \}\)/);
  assert.match(viewer, /class="file-loading"/);
  assert.doesNotMatch(viewer, /clampHorizontalScroll|addEventListener\('scroll'/);
  assert.match(viewer, /body\.scrollLeft = 0;\s*body\.scrollTop = 0;/);
  assert.doesNotMatch(viewer, /git-view-loading|Loading diff…|Loading code…/);
  assert.doesNotMatch(viewer, /ui\.highlightCode\(\)/);
  assert.doesNotMatch(css, /\.git-diff-(overlay|header|title|tabs|body)/);
  assert.match(style, /\.file-modal-body \{[^}]*overflow: auto;[^}]*overscroll-behavior-x: auto;[^}]*overscroll-behavior-y: contain;[^}]*scroll-behavior: auto;[^}]*touch-action: pan-x pan-y;[^}]*-webkit-overflow-scrolling: touch/);
  assert.match(css, /\.git-diff-render\{min-width:max-content\}/);
  assert.match(css, /\.git-diff-render \.d2h-file-wrapper\{margin:0!important;border:0!important;border-radius:0!important\}/);
  assert.match(css, /\.git-diff-render \.d2h-file-diff\{overflow:visible\}/);
  assert.match(css, /\.git-diff-render \.d2h-code-linenumber\{[^}]*position:static;[^}]*width:5\.5em;[^}]*min-width:5\.5em;[^}]*max-width:5\.5em;[^}]*border-left:0/);
  assert.match(css, /\.git-diff-render \.d2h-code-linenumber \.line-num1,[\s\S]*?\.git-diff-render \.d2h-code-linenumber \.line-num2\{[^}]*width:2\.75em;[^}]*padding:0 \.1em/);
  assert.match(css, /\.git-diff-render \.d2h-code-line\{width:auto;padding:0 \.5em\}/);
  assert.match(page, /getElementById\('fileOverlay'\)\?\.style\.display !== 'flex'/);
});

test('Files and Git preserve one level of secondary-page return history', () => {
  const app = fs.readFileSync(path.join(ROOT, 'web/js/app.js'), 'utf8');
  const git = fs.readFileSync(path.join(ROOT, 'web/js/git/status.js'), 'utf8');
  const files = fs.readFileSync(path.join(ROOT, 'web/js/project/browser.js'), 'utf8');
  assert.match(app, /function openGitStatusPage\(options\)/);
  assert.match(git, /returnToFiles/);
  assert.match(git, /openProjectFilesFromGit/);
  assert.match(git, /resumeProjectFilesFromGit/);
  assert.match(files, /returnToGit/);
  assert.match(files, /if \(returning\) window\.openGitStatusPage/);
});
