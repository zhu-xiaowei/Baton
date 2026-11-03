import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { Marked } from 'marked';
import hljs from 'highlight.js';
import { createVisualizationIconRuntime } from '../../web/js/components/visualization-icons.js';

const iconRuntime = createVisualizationIconRuntime(fs.readFileSync(
  new URL('../../node_modules/lucide/dist/umd/lucide.min.js', import.meta.url), 'utf8',
));

const markdown = fs.readFileSync(new URL('../../web/js/components/markdown.js', import.meta.url), 'utf8');
const zoomHelpers = fs.readFileSync(new URL('../../web/js/page-zoom.js', import.meta.url), 'utf8')
  .replace(/^export /gm, '');
const viewer = fs.readFileSync(new URL('../../web/js/components/visualization.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
const sessionId = '01a0ad28-6fcc-7d73-a895-423b4f1dfa03';
const filePath = `/home/test/.codex/visualizations/2026/09/17/${sessionId}/command-line-button.html`;
const marker = 'visualize' + JSON.stringify({ path: filePath }) + '';

test('preview frames inherit the application theme instead of selecting the browser theme', () => {
  const css = fs.readFileSync(new URL('../../web/css/visualization.css', import.meta.url), 'utf8');
  const dom = new JSDOM('<style>' + css + '</style>');
  try {
    const rules = [...dom.window.document.styleSheets[0].cssRules];
    const frame = rules.find(rule => rule.selectorText === '.visualization-frame');
    assert.equal(frame.style.getPropertyValue('color-scheme'), 'inherit');
    const surface = rules.find(rule => rule.selectorText === '.visualization-surface');
    assert.equal(surface.style.getPropertyValue('color-scheme'), 'inherit');
  } finally {
    dom.window.close();
  }
});

test('fullscreen affordance supports mouse hover, keyboard focus and touch without hiding close', () => {
  const css = fs.readFileSync(new URL('../../web/css/visualization.css', import.meta.url), 'utf8');
  const dom = new JSDOM('<style>' + css + '</style>');
  try {
    const rules = [...dom.window.document.styleSheets[0].cssRules];
    const mouse = rules.find(rule => rule.conditionText === '(hover: hover) and (pointer: fine)');
    assert.ok(mouse);
    assert.equal(mouse.cssRules[0].style.opacity, '0');
    assert.match(mouse.cssRules[1].selectorText, /\.visualization-surface:hover/);
    assert.match(mouse.cssRules[1].selectorText, /:focus-visible/);
    assert.equal(mouse.cssRules[1].style.opacity, '1');
    assert.doesNotMatch(mouse.cssText, /visualization-close|visibility:\s*hidden/);
    const touch = rules.find(rule => rule.conditionText?.includes('(any-pointer: coarse)'));
    assert.ok(touch);
    assert.equal(touch.cssRules[0].style.opacity, '1');
    assert.equal(touch.cssRules[1].style.inset, '-6px');
    assert.ok(rules.indexOf(touch) > rules.indexOf(mouse));
  } finally {
    dom.window.close();
  }
});

test('fullscreen uses native safe-area values and reserves space for the close control', () => {
  const css = fs.readFileSync(new URL('../../web/css/visualization.css', import.meta.url), 'utf8');
  const dom = new JSDOM('<style>' + css + '</style>');
  try {
    const rules = [...dom.window.document.styleSheets[0].cssRules];
    const surface = rules.find(rule => rule.selectorText === '.visualization-surface.is-fullscreen');
    for (const [variable, side] of [['sat', 'top'], ['sar', 'right'], ['sab', 'bottom'], ['sal', 'left']]) {
      assert.ok(surface.style.padding.includes(`var(--${variable}, env(safe-area-inset-${side}, 0px))`));
    }
    assert.match(surface.style.padding, /^calc\(var\(--sat, env\(safe-area-inset-top, 0px\)\) \+ 48px\)/);
    const close = rules.find(rule => rule.selectorText === '.visualization-surface.is-fullscreen .visualization-close');
    assert.equal(close.style.top, 'calc(var(--sat, env(safe-area-inset-top, 0px)) + 8px)');
    assert.equal(close.style.right, 'calc(var(--sar, env(safe-area-inset-right, 0px)) + 8px)');
  } finally {
    dom.window.close();
  }
});

function setup(t, request = async () => ({ content: '<style>body{color:red}</style><button>Preview</button>' }), configure = () => {}) {
  const dom = new JSDOM('<!doctype html><body><div class="assistant-text" id="content"></div></body>', {
    runScripts: 'outside-only', url: 'https://baton.test', pretendToBeVisual: true,
  });
  const { window } = dom;
  window.TextEncoder = TextEncoder;
  window.marked = new Marked();
  window.hljs = hljs;
  window.state = {
    appState: { device: 'Mac', project: { hash: 'project', name: 'Project' }, session: 'codex:root' },
    activeThreadId: `codex:${sessionId}`,
  };
  window.requestProjectFiles = request;
  window.loadVisualizationIcons = async () => iconRuntime;
  configure(window);
  window.eval(markdown);
  window.eval(zoomHelpers + '\n' + viewer);
  t.after(() => window.close());
  return window;
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test('complete markers render in history; code, invalid JSON and partial markers stay literal', t => {
  const window = setup(t);
  const host = window.document.getElementById('content');
  host.innerHTML = window.renderAssistantText('Design\n\n' + marker);
  assert.equal(host.querySelector('.codex-visualization').dataset.visualizationPath, filePath);
  for (const input of ['`' + marker + '`', '```text\n' + marker + '\n```', marker.slice(0, -1),
    'visualize{invalid}', 'visualize{"path":42}']) {
    host.innerHTML = window.renderMd(input);
    assert.equal(host.querySelector('.codex-visualization'), null, input);
    assert.ok(host.textContent.includes('visualize'));
  }
});

test('marker paths are escaped, never interpreted as attributes', t => {
  const window = setup(t);
  const host = window.document.getElementById('content');
  const maliciousPath = '/tmp/" onmouseover="alert(1).html';
  host.innerHTML = window.renderMd('visualize' + JSON.stringify({ path: maliciousPath }) + '');
  assert.equal(host.querySelector('.codex-visualization').dataset.visualizationPath, maliciousPath);
  assert.equal(host.querySelector('[onmouseover]'), null);
});

test('streaming preserves preview identity and coexists with Mermaid and trailing prose', t => {
  const window = setup(t);
  const host = window.document.getElementById('content');
  const prefix = 'Design\n\n```mermaid\nflowchart LR\nA-->B\n```\n\n';
  window.renderStreamMd(host, prefix + marker.slice(0, -1));
  assert.equal(host.querySelector('.codex-visualization'), null);
  window.renderStreamMd(host, prefix + marker);
  const block = host.querySelector('.codex-visualization');
  assert.ok(block);
  const frame = window.document.createElement('iframe');
  block.appendChild(frame);
  window.renderStreamMd(host, prefix + marker + '\n\nMore details');
  assert.equal(host.querySelector('.codex-visualization'), block);
  assert.equal(host.querySelector('iframe'), frame);
  assert.ok(host.querySelector('.mermaid-block'));
  assert.match(host.textContent, /More details/);
});

test('preview validates reads and resizing, follows bottom and preserves manual scroll', async t => {
  const calls = [];
  const window = setup(t, async (operation, fields) => {
    calls.push({ operation, fields });
    return { content: '<style>body{color:red}</style><button>Preview</button>' };
  });
  const host = window.document.getElementById('content');
  let scrollHeight = 1000;
  Object.defineProperty(host, 'scrollHeight', { get: () => scrollHeight });
  window.state.stickBottom = true;
  host.innerHTML = window.renderMd(marker);
  await settle();
  assert.equal(host.scrollTop, 1000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].operation, 'read');
  assert.equal(calls[0].fields.projectHash, 'project');
  assert.equal(calls[0].fields.path, filePath);
  assert.equal(host.querySelector('.visualization-head'), null);
  assert.equal(host.querySelector('[data-visualization-action]'), null);
  const frame = host.querySelector('iframe');
  assert.ok(frame);
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
  assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer');
  assert.match(frame.srcdoc, /connect-src 'none'/);
  assert.equal(host.querySelector('style'), null);
  const channel = JSON.parse(frame.srcdoc.match(/channel:("[^"]+")/)[1]);
  scrollHeight = 1500;
  window.dispatchEvent(new window.MessageEvent('message', {
    source: window, data: { type: 'baton-visualization-size', channel, height: 850 },
  }));
  assert.equal(frame.style.height, '');
  assert.equal(host.scrollTop, 1000);
  window.dispatchEvent(new window.MessageEvent('message', {
    source: frame.contentWindow, data: { type: 'baton-visualization-size', channel, height: 600 },
  }));
  assert.equal(frame.style.height, '602px');
  assert.equal(host.scrollTop, 1500);
  window.state.stickBottom = false;
  host.scrollTop = 640;
  scrollHeight = 1800;
  window.dispatchEvent(new window.MessageEvent('message', {
    source: frame.contentWindow, data: { type: 'baton-visualization-size', channel, height: 99999 },
  }));
  assert.equal(frame.style.height, '900px');
  assert.equal(host.scrollTop, 640);
  const block = frame.closest('.codex-visualization');
  block.style.minHeight = '24px';
  block.getBoundingClientRect = () => ({ height: 900 });
  host.scrollTop = 640;
  window.state.stickBottom = true;
  host.querySelector('.visualization-expand').click();
  assert.ok(host.querySelector('.is-fullscreen'));
  assert.equal(block.style.minHeight, '900px');
  window.dispatchEvent(new window.MessageEvent('message', {
    source: frame.contentWindow, data: { type: 'baton-visualization-size', channel, height: 180 },
  }));
  assert.equal(frame.style.height, '900px');
  assert.equal(host.scrollTop, 640);
  assert.equal(host.querySelector('iframe'), frame);
  host.scrollTop = 0;
  host.querySelector('.visualization-close').click();
  assert.equal(host.querySelector('.is-fullscreen'), null);
  assert.equal(block.style.minHeight, '24px');
  assert.equal(host.scrollTop, 640);
  assert.equal(host.querySelector('iframe'), frame);
  assert.equal(calls.length, 1);
});

test('offline errors retry on reconnect and stale responses do not mount into another session', async t => {
  let resolveRequest;
  let offline = true;
  const window = setup(t, () => {
    if (offline) return Promise.reject(new Error('Bridge offline'));
    return new Promise(resolve => { resolveRequest = resolve; });
  });
  const host = window.document.getElementById('content');
  host.innerHTML = window.renderMd(marker);
  await settle();
  assert.match(host.textContent, /Bridge offline/);
  offline = false;
  window.document.dispatchEvent(new window.Event('visibilitychange'));
  window.state.activeThreadId = 'codex:other-thread';
  resolveRequest({ content: '<b>Stale</b>' });
  await settle();
  assert.equal(host.querySelector('iframe'), null);
});

test('full documents lose base and refresh metadata, and inline interaction scripts still work', t => {
  const window = setup(t);
  const source = '<html><head><base href="https://evil.test"><meta http-equiv="refresh" content="0;url=https://evil.test"></head>'
    + '<body><button id="toggle">Open</button><script>document.getElementById("toggle").onclick=function(){this.textContent="Closed"}</script></body></html>';
  const html = window.createVisualizationDocument(source, 'test-channel');
  assert.doesNotMatch(html, /<base|http-equiv="refresh"/);
  const preview = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
  t.after(() => preview.window.close());
  preview.window.document.getElementById('toggle').click();
  assert.equal(preview.window.document.getElementById('toggle').textContent, 'Closed');
});

test('preview retains authored theme attributes, metadata and explicit SVG colors', t => {
  const window = setup(t);
  const source = '<html lang="zh" dir="ltr" class="light" data-theme="light" style="color-scheme:light">'
    + '<head><meta name="color-scheme" content="light"><meta name="viewport" content="width=640">'
    + '<style>html{--color-text-primary:#123456}body{background:white;color:black}</style></head>'
    + '<body class="design" style="padding:24px"><svg width="24" fill="#000" stroke="#f00"></svg></body></html>';
  const html = window.createVisualizationDocument(source, 'theme-test');
  const parsed = new window.DOMParser().parseFromString(html, 'text/html');
  assert.equal(parsed.documentElement.lang, 'zh');
  assert.equal(parsed.documentElement.dataset.theme, 'light');
  assert.equal(parsed.documentElement.className, 'light');
  assert.equal(parsed.documentElement.style.colorScheme, 'light');
  assert.equal(parsed.body.className, 'design');
  assert.equal(parsed.body.style.padding, '24px');
  assert.equal(parsed.querySelector('meta[name="color-scheme"]').content, 'light');
  assert.equal(parsed.querySelectorAll('meta[name="viewport"]').length, 1);
  assert.equal(parsed.querySelector('meta[name="viewport"]').content, 'width=640');
  assert.match(parsed.querySelector('style').textContent, /:where\(html\)/);
  assert.doesNotMatch(parsed.querySelector('style').textContent, /color-scheme|svg/);
  assert.equal(parsed.querySelector('svg').getAttribute('fill'), '#000');
  assert.equal(parsed.querySelector('svg').getAttribute('stroke'), '#f00');
});

test('fixed and unknown palettes keep native colors without injected background or text colors', t => {
  const window = setup(t);
  for (const source of [
    '<p>Plain text</p><svg fill="black"></svg>',
    '<style>body{background:white}.icon{color:black}</style><i class="icon">Icon</i>',
    '<style>@layer artwork{html{background:#17202a;color:#abcdef}}</style><p>Dark artwork</p>',
  ]) {
    const parsed = new window.DOMParser().parseFromString(window.createVisualizationDocument(source, 'fixed'), 'text/html');
    const defaults = parsed.querySelector('style').textContent;
    assert.match(defaults, /^@layer baton-visualization-defaults/);
    assert.doesNotMatch(defaults, /color-scheme|--color-|background|\bcolor:|\bfilter:/);
    const original = new window.DOMParser().parseFromString(source, 'text/html');
    assert.deepEqual([...parsed.querySelectorAll('style')].slice(1).map(style => style.textContent),
      [...original.querySelectorAll('style')].map(style => style.textContent));
  }
});

test('adaptive CSS functions follow the host scheme without repainting content', t => {
  const window = setup(t);
  for (const source of [
    '<style>.card{color:light-dark(black,white);background:light-dark(white,black)}</style>',
    '<style>@layer artwork{@supports (color:light-dark(black,white)){.card{--ink:light-dark(black,white)}}}</style>',
    '<div style="color:light-dark(black,white)">Inline theme</div>',
  ]) {
    const parsed = new window.DOMParser().parseFromString(window.createVisualizationDocument(source, 'adaptive'), 'text/html');
    const defaults = parsed.querySelector('style').textContent;
    assert.match(defaults, /color-scheme:dark;/);
    assert.doesNotMatch(defaults, /--color-|background|\bcolor:/);
  }
  window.document.documentElement.style.colorScheme = 'light';
  const light = window.createVisualizationDocument('<div style="color:light-dark(black,white)">Theme</div>', 'light');
  assert.match(light, /color-scheme:light;/);
});

test('native theme media queries and explicit metadata remain authoritative', t => {
  const window = setup(t);
  const styles = '@media(prefers-color-scheme:dark){body{background:#111;color:white}}';
  const source = '<style>' + styles + '</style><div style="color:light-dark(black,white)">Theme</div>';
  const parsed = new window.DOMParser().parseFromString(window.createVisualizationDocument(
    '<meta name="color-scheme" content="only light">' + source, 'explicit'), 'text/html');
  assert.equal(parsed.querySelector('meta[name="color-scheme"]').content, 'only light');
  assert.doesNotMatch(parsed.querySelector('style').textContent, /color-scheme/);
  assert.equal(parsed.querySelectorAll('style')[1].textContent, styles);
  const mediaOnly = new window.DOMParser().parseFromString(window.createVisualizationDocument(
    '<style>' + styles + '</style>', 'media'), 'text/html');
  assert.doesNotMatch(mediaOnly.querySelector('style').textContent, /color-scheme/);
});

test('theme detection ignores scripts, visible text, comments and CSS string literals', t => {
  const window = setup(t);
  const source = '<script>const example="light-dark(black,white)";</script>'
    + '<p>var(--color-text-primary) and light-dark(black,white)</p>'
    + '<style type="text/plain">body{color:light-dark(black,white)}</style>'
    + '<style>/* light-dark(black,white) */'
    + 'body::before{content:"light-dark(black,white) var(--color-text-primary)"}'
    + 'html{--example:"light-dark(black,white)";--unrelated:custom-light-dark(black,white);'
    + '--another:custom-var(--color-text-primary)}</style>';
  const parsed = new window.DOMParser().parseFromString(window.createVisualizationDocument(source, 'literal'), 'text/html');
  assert.doesNotMatch(parsed.querySelector('style').textContent, /color-scheme|--color-/);
});

test('host theme variables only fill unresolved references without authored fallbacks', t => {
  const window = setup(t);
  const source = '<style>.card{color:var(--color-text-primary);background:var(--color-background-primary);'
    + 'border-color:var(--color-border-primary,#abcdef);font-family:var(--font-mono)}'
    + 'html{--color-text-secondary:#123456}.caption{color:var(--color-text-secondary)}</style>';
  const parsed = new window.DOMParser().parseFromString(window.createVisualizationDocument(source, 'tokens'), 'text/html');
  const defaults = parsed.querySelector('style').textContent;
  assert.match(defaults, /color-scheme:dark;/);
  assert.match(defaults, /--color-text-primary:light-dark/);
  assert.match(defaults, /--color-background-primary:light-dark/);
  assert.match(defaults, /--font-mono:ui-monospace,monospace;/);
  assert.doesNotMatch(defaults, /--color-text-secondary|--color-border-primary/);
  const fixed = new window.DOMParser().parseFromString(window.createVisualizationDocument(
    '<style>html{--color-text-primary:black}body{color:var(--color-text-primary);'
    + 'background:var(--color-background-primary,white)}</style>', 'fixed-tokens'), 'text/html');
  assert.doesNotMatch(fixed.querySelector('style').textContent, /color-scheme|--color-/);
});

test('unavailable CSS inspection conservatively keeps native rendering', t => {
  const window = setup(t);
  window.CSSStyleSheet = undefined;
  const styles = 'body{color:light-dark(black,white)}';
  const parsed = new window.DOMParser().parseFromString(window.createVisualizationDocument(
    '<style>' + styles + '</style>', 'unsupported'), 'text/html');
  assert.doesNotMatch(parsed.querySelector('style').textContent, /color-scheme|--color-/);
  assert.equal(parsed.querySelectorAll('style')[1].textContent, styles);
});

test('theme variables survive CSSOM shorthand expansion with pending longhand values', t => {
  const window = setup(t);
  window.CSSStyleSheet = class {
    replaceSync() {}
    get cssRules() {
      return [{ style: {
        0: 'background-color', length: 1,
        cssText: 'background:var(--color-background-primary);',
        getPropertyValue: () => '',
      } }];
    }
  };
  const parsed = new window.DOMParser().parseFromString(window.createVisualizationDocument(
    '<style>body{background:var(--color-background-primary)}</style>', 'shorthand'), 'text/html');
  assert.match(parsed.querySelector('style').textContent, /--color-background-primary:light-dark/);
});

test('registered custom properties are not shadowed by host theme variables', t => {
  const window = setup(t);
  window.CSSStyleSheet = class {
    replaceSync() {}
    get cssRules() {
      return [
        { name: '--color-text-primary', initialValue: 'black' },
        { style: { 0: 'color', length: 1, cssText: 'color:var(--color-text-primary);' } },
      ];
    }
  };
  const parsed = new window.DOMParser().parseFromString(window.createVisualizationDocument(
    '<style>@property --color-text-primary{syntax:"<color>";inherits:true;initial-value:black}'
    + 'body{color:var(--color-text-primary)}</style>', 'registered'), 'text/html');
  assert.doesNotMatch(parsed.querySelector('style').textContent, /color-scheme|--color-/);
});

test('bundled Lucide renders static and dynamic icons without network dependencies', async t => {
  const window = setup(t);
  const names = ['layers-2', 'git-branch', 'folder', 'terminal', 'message-square', 'x'];
  const source = '<div style="color:#a4e5ca">'
    + names.map(name => '<i data-lucide="' + name + '" aria-hidden="true"></i>').join('')
    + '<i id="custom" data-lucide="search" width="28" height="30" stroke="#123456" aria-label="Search"></i>'
    + '</div><script>window.runtimeReady=Boolean(lucide.icons);lucide.createIcons();'
    + 'window.originalIcon=document.querySelector("svg");</script>';
  const html = window.createVisualizationDocument(source, 'icons-test', iconRuntime);
  const preview = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
  t.after(() => preview.window.close());
  await new Promise(resolve => preview.window.addEventListener('load', resolve, { once: true }));
  const document = preview.window.document;
  assert.equal(preview.window.runtimeReady, true);
  assert.equal(document.querySelectorAll('i[data-lucide]').length, 0);
  assert.equal(document.querySelectorAll('svg[data-lucide]').length, 7);
  assert.equal(document.querySelector('svg'), preview.window.originalIcon);
  assert.equal(document.querySelector('svg').getAttribute('stroke'), 'currentColor');
  assert.equal(document.querySelector('svg').getAttribute('width'), '16');
  assert.equal(document.querySelector('#custom').getAttribute('width'), '28');
  assert.equal(document.querySelector('#custom').getAttribute('height'), '30');
  assert.equal(document.querySelector('#custom').getAttribute('stroke'), '#123456');
  assert.equal(document.querySelector('#custom').getAttribute('aria-label'), 'Search');
  const dynamic = document.createElement('i');
  dynamic.id = 'dynamic';
  dynamic.setAttribute('data-lucide', 'terminal');
  document.body.appendChild(dynamic);
  preview.window.lucide.createIcons({ attrs: { width: 22, height: 22 } });
  assert.equal(document.querySelector('#dynamic').localName, 'svg');
  assert.equal(document.querySelector('#dynamic').getAttribute('width'), '22');
  assert.equal(document.querySelector('script[src], link[rel="stylesheet"]'), null);
  assert.match(document.querySelector('meta[http-equiv]').content, /connect-src 'none'/);
  assert.doesNotMatch(iconRuntime, /<\/script|sourceMappingURL=/i);
});

test('static placeholders initialize automatically after the fragment scripts', async t => {
  const window = setup(t);
  const html = window.createVisualizationDocument('<i data-lucide="terminal"></i>', 'static-icons', iconRuntime);
  const preview = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
  t.after(() => preview.window.close());
  await new Promise(resolve => preview.window.addEventListener('load', resolve, { once: true }));
  assert.equal(preview.window.document.querySelectorAll('svg[data-lucide="terminal"]').length, 1);
  assert.equal(preview.window.document.querySelector('svg').getAttribute('height'), '16');
});

test('icon runtime is lazy and only loaded when the artifact needs it', async t => {
  const window = setup(t);
  let loads = 0;
  window.loadVisualizationIcons = async () => { loads++; return iconRuntime; };
  const host = window.document.getElementById('content');
  host.innerHTML = window.renderMd(marker);
  await settle();
  assert.equal(loads, 0);
  window.requestProjectFiles = async () => ({ content: '<i data-lucide="folder"></i>' });
  await window.loadVisualization(host.querySelector('.codex-visualization'), true);
  assert.equal(loads, 1);
  assert.match(host.querySelector('iframe').srcdoc, /lucide v1\.47\.0/);
  assert.equal(window.lucide, undefined);
});

test('preview references are validated before using the authenticated file reader', async t => {
  let requests = 0;
  const window = setup(t, async () => { requests++; return { content: '<b>Unsafe</b>' }; });
  const host = window.document.getElementById('content');
  for (const invalidPath of ['/etc/secrets.html', filePath.replace(sessionId, 'another-session'),
    filePath.replace('/visualizations/', '/../visualizations/'), filePath.replace('.html', '.json')]) {
    assert.throws(() => window.validateVisualizationPath(invalidPath, sessionId), /this session/);
  }
  window.validateVisualizationPath(filePath, `codex:${sessionId}`);
  window.validateVisualizationPath(`C:\\Users\\test\\.codex\\visualizations\\2026\\09\\17\\${sessionId}\\preview.html`, sessionId);
  host.innerHTML = window.renderMd('visualize{"path":"/etc/secrets.html"}');
  await settle();
  assert.equal(requests, 0);
  assert.match(host.textContent, /this session/);
});

test('existing uploaded-file responses are supported without a new backend operation', async t => {
  const window = setup(t, async () => ({ content: '', key: 'preview.html', size: 350000 }));
  let requestedUrl;
  window.apiText = async url => { requestedUrl = url; return '<button>Loaded file</button>'; };
  window.document.getElementById('content').innerHTML = window.renderMd(marker);
  await settle();
  assert.equal(requestedUrl, '/api/bridge/file/preview.html');
  assert.match(window.document.querySelector('iframe').srcdoc, /Loaded file/);
});

test('project-local replacement designs use a project-relative read instead of being rejected', async t => {
  const requests = [];
  const window = setup(t, async (operation, fields) => {
    requests.push({ operation, fields });
    return { content: '<div id="capsule">New capsule design</div>' };
  });
  window.state.appState.project = { hash: '-Users-xiaoweii-workspace-rn-agentpeek', name: 'agentpeek' };
  const artifact = '/Users/xiaoweii/workspace/rn/agentpeek/output/design-preview/command-line-capsule.html';
  const host = window.document.getElementById('content');
  host.innerHTML = window.renderMd('visualize' + JSON.stringify({ path: artifact }) + '');
  await settle();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].operation, 'read');
  assert.equal(requests[0].fields.projectHash, '-Users-xiaoweii-workspace-rn-agentpeek');
  assert.equal(requests[0].fields.path, 'output/design-preview/command-line-capsule.html');
  assert.match(host.querySelector('iframe').srcdoc, /New capsule design/);
  assert.equal(host.querySelector('.visualization-status').hidden, true);
});

test('project matching respects directory boundaries, traversal and supported Windows hashes', t => {
  const window = setup(t);
  const projectHash = '-home-test-my-project';
  const resolve = artifact => window.validateVisualizationPath(artifact, sessionId, projectHash);
  assert.equal(resolve('/home/test/my-project/output/design.html'), 'output/design.html');
  assert.equal(resolve('/home/test/my-project/design.htm'), 'design.htm');
  for (const artifact of ['/home/test/my-project-other/design.html', '/home/test/other/design.html',
    '/home/test/my-project/../other/design.html', '/home/test/my-project/./design.html',
    '/home/test/my-project/design.json', 'https://example.test/design.html']) {
    assert.throws(() => resolve(artifact), /this session or its project/);
  }
  for (const windowsHash of ['C--Users-test-my-project', 'C-Users-test-my-project']) {
    assert.equal(window.validateVisualizationPath('c:\\Users\\test\\my-project\\output\\design.html',
      sessionId, windowsHash), 'output/design.html');
  }
  assert.equal(window.validateVisualizationPath('/home/test/my.project/output/design.html',
    sessionId, '-home-test-my-project'), 'output/design.html');
});

test('oversized and binary content never runs in a preview', async t => {
  const window = setup(t, async () => ({ content: '<b>oversized</b>', size: 1024 * 1024 + 1 }));
  const host = window.document.getElementById('content');
  host.innerHTML = window.renderMd(marker);
  await settle();
  assert.equal(host.querySelector('iframe'), null);
  assert.match(host.textContent, /1 MB/);
  window.requestProjectFiles = async () => ({ content: '\0binary', size: 7 });
  window.dispatchEvent(new window.Event('online'));
  await settle();
  assert.equal(host.querySelector('iframe'), null);
});

test('fullscreen keeps native edge-back reachable and retains desktop modal behavior', async t => {
  for (const nativeMobile of [true, false]) {
    let layer;
    const window = setup(t, undefined, window => {
      window.__BATON_NATIVE_MOBILE__ = nativeMobile;
      window.registerEdgeBackLayer = options => {
        layer = { ...options, active: false,
          activate() { this.active = true; },
          deactivate() { this.active = false; },
        };
        return layer;
      };
    });
    const host = window.document.getElementById('content');
    host.innerHTML = window.renderMd(marker);
    await settle();
    const block = host.querySelector('.codex-visualization');
    const surface = block.querySelector('.visualization-surface');
    const frame = block.querySelector('iframe');
    const requests = [];
    frame.contentWindow.postMessage = message => requests.push(message);
    let modalCalls = 0;
    surface.showModal = () => { modalCalls++; surface.open = true; };
    surface.close = () => { surface.open = false; };
    window.openVisualizationFullscreen(block);
    assert.equal(modalCalls, nativeMobile ? 0 : 1);
    const snapshot = block.querySelector('.visualization-snapshot');
    assert.equal(!!snapshot, nativeMobile);
    if (nativeMobile) {
      assert.equal(snapshot.getAttribute('sandbox'), '');
      assert.equal(snapshot.getAttribute('aria-hidden'), 'true');
      assert.equal(snapshot.tabIndex, -1);
      assert.equal(snapshot.inert, true);
      const request = requests[0];
      const html = '<p>Current preview state</p><script>window.ran=true</script>';
      for (const source of [window, frame.contentWindow]) {
        window.dispatchEvent(new window.MessageEvent('message', {
          source, data: { ...request, type: 'baton-visualization-snapshot', html },
        }));
        assert.equal(snapshot.srcdoc.includes('Current preview state'), source === frame.contentWindow);
      }
      assert.doesNotMatch(snapshot.srcdoc, /<script/);
      assert.match(snapshot.srcdoc, /connect-src 'none'/);
      window.dispatchEvent(new window.MessageEvent('message', {
        source: frame.contentWindow,
        data: { ...request, requestId: 'stale', type: 'baton-visualization-snapshot', html: '<p>Stale</p>' },
      }));
      assert.equal(snapshot.srcdoc.includes('Current preview state'), true);
    }
    assert.equal(layer.active, true);
    assert.deepEqual(Array.from(layer.foregroundSelectors), ['.visualization-surface.is-fullscreen']);
    assert.equal(layer.navigateBack(), true);
    assert.equal(layer.active, false);
    assert.equal(surface.classList.contains('is-fullscreen'), false);
    assert.equal(surface.open, true);
    assert.equal(block.querySelector('.visualization-snapshot'), null);
    assert.equal(block.querySelector('iframe'), frame);
    assert.equal(window.state.appState.session, 'codex:root');
  }
});

test('snapshot bridge captures rendered controls, styles and canvas without replaying scripts', async t => {
  const window = setup(t);
  const html = window.createVisualizationDocument('<style>p{color:red}</style><p>Initial</p>'
    + '<input value="initial"><input type="checkbox"><textarea>initial</textarea>'
    + '<select><option>First</option><option>Second</option></select><canvas width="40" height="20"></canvas>', 'snapshot-test');
  const preview = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,canvas';
    },
  });
  t.after(() => preview.window.close());
  await new Promise(resolve => preview.window.addEventListener('load', resolve, { once: true }));
  const document = preview.window.document;
  document.querySelector('p').textContent = 'Updated';
  document.querySelector('input').value = 'edited';
  document.querySelector('[type="checkbox"]').checked = true;
  document.querySelector('textarea').value = 'changed';
  document.querySelector('select').selectedIndex = 1;
  document.querySelector('style').sheet.insertRule('.dynamic{color:blue}');
  const response = new Promise(resolve => preview.window.addEventListener('message', event => {
    if (event.data.type === 'baton-visualization-snapshot') resolve(event.data);
  }));
  preview.window.dispatchEvent(new preview.window.MessageEvent('message', {
    source: preview.window, data: { type: 'baton-visualization-snapshot-request', channel: 'snapshot-test', requestId: 'current' },
  }));
  const data = await response;
  const captured = new preview.window.DOMParser().parseFromString(data.html, 'text/html');
  assert.equal(data.requestId, 'current');
  assert.equal(captured.querySelector('p').textContent, 'Updated');
  assert.equal(captured.querySelector('input').value, 'edited');
  assert.equal(captured.querySelector('[type="checkbox"]').checked, true);
  assert.equal(captured.querySelector('textarea').value, 'changed');
  assert.equal(captured.querySelector('select').selectedIndex, 1);
  assert.equal(captured.querySelector('img').src, 'data:image/png;base64,canvas');
  assert.match(captured.querySelector('style').textContent, /\.dynamic/);
  assert.equal(captured.querySelector('script'), null);
});

test('fullscreen closes on Escape, verified iframe messages and removal', async t => {
  const window = setup(t);
  const host = window.document.getElementById('content');
  host.innerHTML = window.renderMd(marker);
  await settle();
  const block = host.querySelector('.codex-visualization');
  const frame = block.querySelector('iframe');
  const channel = JSON.parse(frame.srcdoc.match(/channel:("[^"]+")/)[1]);
  window.openVisualizationFullscreen(block);
  window.dispatchEvent(new window.MessageEvent('message', {
    source: window, data: { type: 'baton-visualization-close', channel },
  }));
  assert.ok(block.querySelector('.is-fullscreen'));
  window.dispatchEvent(new window.MessageEvent('message', {
    source: frame.contentWindow, data: { type: 'baton-visualization-close', channel },
  }));
  assert.equal(block.querySelector('.is-fullscreen'), null);
  window.openVisualizationFullscreen(block);
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(block.querySelector('.is-fullscreen'), null);
  window.openVisualizationFullscreen(block);
  block.remove();
  host.scrollTop = 125;
  await settle();
  assert.equal(host.scrollTop, 125);
  assert.equal(window.closeVisualizationFullscreen(), false);
});
