import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FILE_ICON_SVG,
  FOLDER_ICON_SVG,
  TERMINAL_ICON_SVG,
} from '../../web/js/components/icons.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('project icons use shared rounded outlines and consistent toolbar sizing', () => {
  for (const icon of [FOLDER_ICON_SVG, TERMINAL_ICON_SVG]) {
    assert.match(icon, /stroke="currentColor" stroke-width="1\.5" stroke-linecap="round" stroke-linejoin="round"/);
  }
  assert.match(TERMINAL_ICON_SVG, /<rect[^>]*rx="3"/);
  assert.match(FOLDER_ICON_SVG, /<path d="M3 9h18"/);
  assert.match(FILE_ICON_SVG, /M6 3\.5h8l4 4v13H6z/);

  const app = fs.readFileSync(path.join(ROOT, 'web/js/app.js'), 'utf8');
  const browser = fs.readFileSync(path.join(ROOT, 'web/js/project/browser.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'web/css/project-files.css'), 'utf8');
  const style = fs.readFileSync(path.join(ROOT, 'web/css/style.css'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
  assert.ok(html.includes('<g class="recent-folder-closed">' + FOLDER_ICON_SVG.match(/<path.*(?=<\/svg>)/)[0] + '</g>'));
  assert.match(html, /M3 18 6 10\.5Q6\.6 9 8 9h11q2 0 2 2/);
  assert.match(app, /FOLDER_ICON_SVG/);
  assert.match(app, /title="Terminal">' \+ TERMINAL_ICON_SVG/);
  assert.match(browser, /fileIconHtml\(entry\.name\)/);
  assert.match(
    app,
    /topRight\.innerHTML = runtimeMark \+ filesButton \+ gitButton \+ terminalButton[\s\S]*new-session-btn/,
  );
  assert.match(
    css,
    /\.project-files-entry \{[\s\S]*?width: 28px;[\s\S]*?height: 28px;[\s\S]*?flex: 0 0 28px;/,
  );
  assert.match(
    css,
    /\.project-files-entry svg \{[\s\S]*?position: absolute;[\s\S]*?left: 50%;[\s\S]*?width: 22px;[\s\S]*?stroke-width: 1\.5;[\s\S]*?transform: translate\(-50%, -50%\);/,
  );
  assert.match(
    css,
    /html\.native-mobile #top-right \.project-files-entry \{[\s\S]*?width: 44px;[\s\S]*?height: 44px;[\s\S]*?flex-basis: 44px;/,
  );
  assert.match(
    css,
    /html\.native-mobile #top-right \.project-files-entry svg \{\s*width: 24px;\s*height: 24px;\s*\}/,
  );
  assert.match(css, /html\.native-mobile \.edge-back-top-right \.project-files-entry svg \{\s*width: 24px;\s*height: 24px;\s*\}/);
  assert.match(css, /color: var\(--action-icon-color\)/);
  assert.match(style, /\.new-session-btn \{[^}]*color: var\(--action-icon-color\)/);
  assert.match(style, /\.recent-project-icon \{ color: var\(--action-icon-color\)/);
  assert.match(style, /#top-right \.runtime-icon,[^{]*\{ width: 22px; height: 22px;/);
  assert.match(style, /html\.native-mobile #top-right \.runtime-icon,[^{]*\{ width: 24px; height: 24px;/);
  assert.match(style, /#top-right \{[^}]*gap: 8px;/);
  assert.match(style, /html\.native-mobile #top-right \{[^}]*gap: 0;/);
  assert.doesNotMatch(css, /#breadcrumb > \.project-files-entry/);
});
