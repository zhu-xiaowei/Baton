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

test('Chinese labels ending in punctuation stay bold during streaming', () => {
  const window = setupMarkdown();
  const host = window.document.createElement('div');
  const input = '**\u90e8\u7f72\u72b6\u6001\uff1a**\u4e91\u7aef\u5df2\u90e8\u7f72 ,';
  const closingEnd = input.indexOf('**', 2) + 2;

  host.innerHTML = window.renderAssistantText(input);
  assert.equal(host.querySelector('strong')?.textContent, '\u90e8\u7f72\u72b6\u6001\uff1a');
  assert.equal(host.textContent.trim(), '\u90e8\u7f72\u72b6\u6001\uff1a\u4e91\u7aef\u5df2\u90e8\u7f72 ,');

  for (let length = 2; length <= input.length; length++) {
    window.renderStreamMd(host, input.slice(0, length));
    assert.equal(host.querySelector('strong')?.textContent,
      length < closingEnd ? undefined : '\u90e8\u7f72\u72b6\u6001\uff1a');
  }

  host.innerHTML = window.renderMd('\u524d\u6587 **\u6ce8\u610f\uff01**\u8bf7\u68c0\u67e5');
  assert.equal(host.querySelector('strong')?.textContent, '\u6ce8\u610f\uff01');
  window.close();
});

test('Chinese label compatibility preserves Markdown boundaries and HTML escaping', () => {
  const window = setupMarkdown();
  const standard = new Marked({ breaks: true, gfm: true });
  const host = window.document.createElement('div');
  for (const input of [
    '**\u90e8\u7f72\u72b6\u6001\uff1a** \u4e91\u7aef\u5df2\u90e8\u7f72',
    '**\u90e8\u7f72\u72b6\u6001**\uff1a\u4e91\u7aef\u5df2\u90e8\u7f72',
    '**Status:**deployed',
    "\\*\\*\u90e8\u7f72\u72b6\u6001\uff1a\\*\\*\u4e91\u7aef\u5df2\u90e8\u7f72",
    '`**\u90e8\u7f72\u72b6\u6001\uff1a**\u4e91\u7aef\u5df2\u90e8\u7f72`',
    '***\u7c97\u4f53\u548c\u659c\u4f53***',
    '**\u5916\u5c42 *\u5185\u5c42* \u7ed3\u675f**',
    '**\u5185\u542b `\uff1a**\u4e91` \u7684\u4ee3\u7801**',
  ]) {
    assert.equal(window.renderMd(input), standard.parse(input), input);
  }

  host.innerHTML = window.renderMd('```text\n**\u90e8\u7f72\u72b6\u6001\uff1a**\u4e91\u7aef\u5df2\u90e8\u7f72\n```');
  assert.equal(host.querySelector('strong'), null);
  assert.equal(host.querySelector('code').textContent.trim(), '**\u90e8\u7f72\u72b6\u6001\uff1a**\u4e91\u7aef\u5df2\u90e8\u7f72');

  host.innerHTML = window.renderMd('**\u90e8\u7f72&lt;img src=x onerror=alert(1)&gt;\uff1a**\u4e91\u7aef\u5df2\u90e8\u7f72');
  assert.equal(host.querySelector('img'), null);
  assert.equal(host.querySelector('strong')?.textContent, '\u90e8\u7f72<img src=x onerror=alert(1)>\uff1a');
  window.close();
});
