import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const detectorSource = readFileSync(
  new URL('../../web/public/native-mobile.js', import.meta.url),
  'utf8',
);

function detectNativeMobile({
  tauri = false,
  userAgent = '',
  platform = '',
  maxTouchPoints = 0,
} = {}) {
  const classes = new Set();
  const context = {
    navigator: { userAgent, platform, maxTouchPoints },
    document: {
      documentElement: {
        classList: {
          toggle(name, enabled) {
            if (enabled) classes.add(name);
            else classes.delete(name);
          },
        },
      },
    },
    window: tauri ? { __TAURI_INTERNALS__: {} } : {},
  };

  vm.runInNewContext(detectorSource, context);
  return {
    classApplied: classes.has('native-mobile'),
    flag: context.window.__AGENTPEEK_NATIVE_MOBILE__,
  };
}

test('native mobile detection requires Tauri and a mobile operating system', () => {
  const cases = [
    {
      name: 'Tauri iPhone',
      input: { tauri: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' },
      expected: true,
    },
    {
      name: 'Tauri Android',
      input: { tauri: true, userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9)' },
      expected: true,
    },
    {
      name: 'Tauri iPad using desktop identity',
      input: { tauri: true, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', platform: 'MacIntel', maxTouchPoints: 5 },
      expected: true,
    },
    {
      name: 'Tauri macOS',
      input: { tauri: true, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', platform: 'MacIntel' },
      expected: false,
    },
    {
      name: 'mobile Safari outside Tauri',
      input: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' },
      expected: false,
    },
    {
      name: 'narrow desktop browser',
      input: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', platform: 'MacIntel' },
      expected: false,
    },
  ];

  for (const scenario of cases) {
    const result = detectNativeMobile(scenario.input);
    assert.equal(result.classApplied, scenario.expected, scenario.name);
    assert.equal(result.flag, scenario.expected, `${scenario.name} global flag`);
  }
});

test('all entry pages run mobile detection before their first style block', () => {
  for (const filename of ['index.html', 'landing.html', 'setup.html']) {
    const html = readFileSync(new URL(`../../web/${filename}`, import.meta.url), 'utf8');
    const detectorIndex = html.indexOf('<script src="/native-mobile.js"></script>');
    assert.notEqual(detectorIndex, -1, `${filename} includes native mobile detection`);
    assert.ok(detectorIndex < html.indexOf('<style>'), `${filename} detects before styling`);
  }
});

test('mobile readability styles are scoped to the native mobile class', () => {
  const css = readFileSync(new URL('../../web/css/style.css', import.meta.url), 'utf8');
  const setup = readFileSync(new URL('../../web/setup.html', import.meta.url), 'utf8');

  assert.doesNotMatch(css, /@media\s*\(max-width:\s*767px\)/);
  assert.doesNotMatch(setup, /@media\s*\(max-width:\s*767px\)/);
  assert.match(css, /html\.native-mobile \.assistant-text\s*\{\s*font-size:\s*16px/);
  assert.match(css, /html\.native-mobile \.msg-system-event\s*\{\s*font-size:\s*14px;\s*line-height:\s*21px;/);
  assert.match(css, /html\.native-mobile \.summary-block > summary\s*\{\s*font-size:\s*14px;\s*line-height:\s*21px;/);
  assert.match(css, /html\.native-mobile #top-right\.select-actions\s*\{[^}]*gap:\s*8px;[^}]*padding:\s*0 2px 4px 0;/s);
  assert.match(css, /html\.native-mobile #top-right\.select-actions \.text-btn\s*\{[^}]*height:\s*32px;[^}]*min-height:\s*32px;/s);
  assert.match(setup, /html\.native-mobile \.setup-bar \.title\s*\{\s*font-size:\s*17px/);
});

test('file preview uses one circled close icon across desktop and native mobile', () => {
  const css = readFileSync(new URL('../../web/css/style.css', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');

  assert.match(html, /<button type="button" class="file-modal-close"[^>]*aria-label="Close"/);
  assert.doesNotMatch(html, /file-modal-close-glyph/);
  assert.match(css, /\.file-modal-close-icon\s*\{[^}]*display:\s*block;[^}]*border:\s*1\.5px solid currentColor;[^}]*border-radius:\s*50%;[^}]*rotate\(45deg\)/s);
  assert.match(css, /html\.native-mobile \.file-modal-close-icon\s*\{[^}]*width:\s*26px;[^}]*height:\s*26px;/s);
});
