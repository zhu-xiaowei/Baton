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
  assert.match(mermaid, /class="mermaid-block"/);
  assert.match(mermaid, /class="mermaid-src"/);
});
