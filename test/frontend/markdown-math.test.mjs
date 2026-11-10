import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import hljs from 'highlight.js';
import { Marked } from 'marked';

const source = fs.readFileSync(new URL('../../web/js/components/markdown.js', import.meta.url), 'utf8');

function setup(t) {
  const { window } = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  t.after(() => window.close());
  window.marked = new Marked();
  window.hljs = hljs;
  window.katexHtml = (tex, display) => {
    const span = window.document.createElement('span');
    span.className = display ? 'katex-display' : 'katex';
    span.textContent = tex;
    return span.outerHTML;
  };
  window.eval(source);
  return window;
}

function checkRenderers(window, input, check) {
  const host = window.document.createElement('div');
  const sanitize = html => {
    const root = window.document.createElement('div');
    root.innerHTML = html;
    window.decorateMarkdown(root);
    return root;
  };
  for (const render of [window.renderMd, window.renderAssistantText,
    text => { window.renderStreamMd(host, text); return host.innerHTML; },
    text => window.renderMdDocument(text, sanitize)]) {
    host.innerHTML = render(input);
    check(host);
  }
}

test('prices preserve dollar signs and bold text, including while streaming', t => {
  const window = setup(t);
  const input = '上行 $0.06 = **+$3**；Pro $15。';
  const expected = new Marked({ breaks: true, gfm: true }).parse(input);
  checkRenderers(window, input, host => assert.equal(host.innerHTML, expected));
  const host = window.document.createElement('div');
  for (let length = input.indexOf('**；') + 2; length <= input.length; length++) {
    window.renderStreamMd(host, input.slice(0, length));
    assert.equal(host.querySelector('strong').textContent, '+$3');
  }
});

test('single tildes remain approximate values and double tildes strike text', t => {
  checkRenderers(setup(t), '~$20 + ~$3 → **~$26**；~~旧方案~~。', host => {
    assert.equal(host.textContent.trim(), '~$20 + ~$3 → ~$26；旧方案。');
    assert.equal(host.querySelector('strong').textContent, '~$26');
    assert.deepEqual([...host.querySelectorAll('del')].map(el => el.textContent), ['旧方案']);
  });
});

test('incomplete math stays literal without swallowing later Markdown or formulas', t => {
  const input = '$$x$\n\n$a **b** c$；公式 $`a * b`$ 和 $x+1$，以及 $$y$$；价格 $$5 和 $$10。\n\n`$x$`';
  checkRenderers(setup(t), input, host => {
    assert.equal(host.querySelector('p').textContent, '$$x$');
    assert.equal(host.querySelector('strong').textContent, 'b');
    assert.deepEqual([...host.querySelectorAll('.katex')].map(el => el.textContent), ['a * b', 'x+1', 'y']);
    assert.equal(host.querySelector('code').textContent, '$x$');
  });
});

test('math fences render display math and ordinary fences stay code', t => {
  checkRenderers(setup(t), '```math\nx^2 + 1\n```\n\n```text\n$x$\n```', host => {
    assert.equal(host.querySelector('.katex-display').textContent, 'x^2 + 1');
    assert.equal(host.querySelectorAll('pre').length, 1);
    assert.equal(host.querySelector('pre code').textContent, '$x$');
  });
  // Only streaming waits for the closing fence; a mismatched fence does not close it.
  const window = setup(t);
  const host = window.document.createElement('div');
  for (const input of ['```math\nx^', '````math\nx^\n```', '~~~math\nx^\n```']) {
    window.renderStreamMd(host, input);
    assert.ok(host.querySelector('pre code').textContent.startsWith('x^'));
  }
  assert.match(window.renderMd('```math\nx^2'), /katex-display/);
  assert.match(window.renderMdDocument('```math\nx^2', html => {
    const root = window.document.createElement('div');
    root.innerHTML = html;
    return root;
  }), /katex-display/);
});

test('GitHub alerts render consistently without interpreting markers in code', t => {
  checkRenderers(setup(t), '> [!WARNING]\n> **Careful**.\n\n```text\n> [!NOTE]\n```', host => {
    assert.equal(host.querySelectorAll('.markdown-alert').length, 1);
    assert.equal(host.querySelector('.markdown-alert-title').textContent, 'Warning');
    assert.equal(host.querySelector('.markdown-alert strong').textContent, 'Careful');
    assert.equal(host.querySelector('code').textContent, '> [!NOTE]');
  });
});
