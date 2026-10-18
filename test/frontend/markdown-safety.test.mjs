import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import hljs from 'highlight.js';
import { Marked } from 'marked';

const source = fs.readFileSync(
  new URL('../../web/js/components/markdown.js', import.meta.url),
  'utf8',
);

function setupMarkdown() {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  if (!hljs.getLanguage('mermaid')) {
    hljs.registerLanguage('mermaid', () => ({ contains: [] }));
  }
  dom.window.marked = new Marked();
  dom.window.hljs = hljs;
  dom.window.eval(source);
  return dom.window;
}

test('assistant raw HTML cannot alter the host page', () => {
  const window = setupMarkdown();
  const input = [
    'card',
    '<invoke name="Write">',
    '<parameter name="content"><!DOCTYPE html>',
    '<html><head>',
    '<meta name="viewport" content="width=1080">',
    '<style>body{font-size:4px;transform:scale(.5)}</style>',
    '</head><body><svg width="1080"></svg></body></html>',
    '</parameter>',
    '</invoke>',
  ].join('\n');

  const host = window.document.createElement('div');
  host.innerHTML = window.renderMd(input);

  assert.equal(host.querySelector('style, meta, svg, invoke, parameter'), null);
  assert.match(host.textContent, /<meta name="viewport"/);
  assert.match(host.textContent, /<style>body\{font-size:4px/);
  assert.equal(window.document.body.style.fontSize, '');
  assert.equal(window.document.body.style.transform, '');
});

test('fenced code highlighting and Mermaid placeholders remain trusted UI', () => {
  const window = setupMarkdown();
  const code = window.renderMd('```js\nconst answer = 42;\n```');
  const mermaid = window.renderMd('```mermaid\nflowchart LR\nA-->B\n```');

  assert.match(code, /^<pre><code class="hljs">/);
  assert.match(code, /hljs-/);
  assert.doesNotMatch(window.renderMd('```\nERROR: retry 3 -> ok\n```'), /hljs-/);
  assert.match(mermaid, /class="mermaid-block"/);
  assert.match(mermaid, /class="mermaid-src"/);
});

test('Chinese labels ending in punctuation stay bold during streaming', () => {
  const window = setupMarkdown();
  const host = window.document.createElement('div');
  const input = '**部署状态：**云端已部署 ,';
  const closingEnd = input.indexOf('**', 2) + 2;

  host.innerHTML = window.renderAssistantText(input);
  assert.equal(host.querySelector('strong')?.textContent, '部署状态：');
  assert.equal(host.textContent.trim(), '部署状态：云端已部署 ,');

  for (let length = 2; length <= input.length; length++) {
    window.renderStreamMd(host, input.slice(0, length));
    assert.equal(host.querySelector('strong')?.textContent,
      length < closingEnd ? undefined : '部署状态：');
  }

  host.innerHTML = window.renderMd('前文 **注意！**请检查');
  assert.equal(host.querySelector('strong')?.textContent, '注意！');
  window.close();
});

test('Chinese label compatibility preserves Markdown boundaries and HTML escaping', () => {
  const window = setupMarkdown();
  const standard = new Marked({ breaks: true, gfm: true });
  const host = window.document.createElement('div');
  for (const input of [
    '**部署状态：** 云端已部署',
    '**部署状态**：云端已部署',
    '**Status:**deployed',
    String.raw`\*\*部署状态：\*\*云端已部署`,
    '`**部署状态：**云端已部署`',
    '***粗体和斜体***',
    '**外层 *内层* 结束**',
    '**内含 `：**云` 的代码**',
  ]) {
    assert.equal(window.renderMd(input), standard.parse(input), input);
  }

  host.innerHTML = window.renderMd('```text\n**部署状态：**云端已部署\n```');
  assert.equal(host.querySelector('strong'), null);
  assert.equal(host.querySelector('code').textContent.trim(), '**部署状态：**云端已部署');

  host.innerHTML = window.renderMd('**部署&lt;img src=x onerror=alert(1)&gt;：**云端已部署');
  assert.equal(host.querySelector('img'), null);
  assert.equal(host.querySelector('strong')?.textContent, '部署<img src=x onerror=alert(1)>：');
  window.close();
});

test('project Markdown keeps GitHub-allowed HTML and strips active content', async () => {
  const window = setupMarkdown();
  globalThis.window = window;
  try {
    const { renderMarkdownDocument } = await import('../../web/js/components/markdown-document.js');
    const host = window.document.createElement('div');
    host.innerHTML = await renderMarkdownDocument([
      '# <sub><picture><source media="(prefers-color-scheme: dark)" srcset="logo.svg"><img src="logo-dark.svg" width="36" alt=""></picture></sub>Baton',
      '',
      '<p align="center" onclick="alert(1)"><img src="docs/a.avif" onerror="alert(1)" style="width:9px"></p>',
      '<script>alert(1)</script><style>body{color:red}</style>',
      '',
      '> [!WARNING]',
      '> Careful',
      '',
      '```js',
      'const x = 1;',
      '```',
      'one',
      'line :rocket: `:tada:` :not_an_emoji:',
      '',
      '[at line](src/app.js:12) [bad](javascript:alert(1))',
    ].join('\n'));

    assert.equal(host.querySelector('script, style, [onclick], [onerror], [style]'), null);
    assert.equal(host.querySelector('h1').id, 'user-content-baton');
    assert.equal(host.querySelector('source').dataset.mdSrcset, 'logo.svg');
    assert.equal(host.querySelector('source').getAttribute('media'), '(min-width: 0px)');
    assert.equal(host.querySelector('p[align="center"] img').dataset.mdSrc, 'docs/a.avif');
    assert.equal(host.querySelector('img[src]'), null);
    assert.equal(host.querySelector('.markdown-alert-warning .markdown-alert-title').textContent, 'Warning');
    assert.match(host.querySelector('pre code.hljs').innerHTML, /hljs-/);
    assert.equal(host.querySelector('br'), null);
    assert.match(host.textContent, /line 🚀 :tada: :not_an_emoji:/);
    assert.equal(host.querySelector('a[href="src/app.js:12"]')?.textContent, 'at line');
    assert.equal(host.querySelector('a[href^="javascript"]'), null);
    assert.match(window.renderMd('<p align="center">x</p>'), /&lt;p align/);
  } finally {
    delete globalThis.window;
    window.close();
  }
});
