import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { Marked } from 'marked';
import hljs from 'highlight.js';
import { initCodeCopy, refreshCodeCopy } from '../../web/js/code-copy.js';

const markdown = fs.readFileSync(new URL('../../web/js/components/markdown.js', import.meta.url), 'utf8');

function setup(t) {
  const dom = new JSDOM('<div id="content"><div class="messages"><div class="tl-item assistant-text"></div></div></div>'
    + '<textarea id="draft">Keep my draft</textarea>',
  { url: 'https://test/', runScripts: 'outside-only', pretendToBeVisual: true });
  for (const key of ['document', 'MutationObserver', 'navigator']) globalThis[key] = dom.window[key];
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  dom.window.marked = new Marked();
  if (!hljs.getLanguage('mermaid')) hljs.registerLanguage('mermaid', () => ({ contains: [] }));
  dom.window.hljs = hljs;
  dom.window.eval(markdown);
  const writes = [];
  dom.window.navigator.clipboard = { writeText: async text => { writes.push(text); } };
  const dispose = initCodeCopy();
  t.after(() => { dispose(); dom.window.close(); });
  const host = document.querySelector('.assistant-text');
  const render = text => { dom.window.renderStreamMd(host, text); refreshCodeCopy(); };
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  return { dom, host, writes, render, tick, dispose };
}

test('copies only decoded highlighted code, preserving whitespace, Unicode and the draft', async t => {
  const { host, render, writes, tick } = setup(t);
  const code = '  const 中文 = "<tag>&";\n    console.log(中文);\n';
  render('Explanation\n```js\n' + code + '\n```\nAfter code');
  const expected = host.querySelector('code').textContent;
  assert.equal(expected, code);
  host.querySelector('.code-copy').click();
  await tick();
  assert.deepEqual(writes, [code]);
  assert.equal(host.querySelector('.code-copy').textContent, 'Copied');
  assert.equal(document.getElementById('draft').value, 'Keep my draft');
  assert.equal(host.querySelector('code').textContent, code);
  host.querySelector('code').textContent = '\tRendered tab\n';
  host.querySelector('.code-copy').click();
  await tick();
  assert.equal(writes[1], '\tRendered tab\n');
});

test('copies the revealed streaming snapshot and renews controls after DOM replacement', async t => {
  const { host, render, writes, tick } = setup(t);
  render('```text\npartial');
  host.querySelector('.code-copy').click();
  await tick();
  render('```text\npartial complete\n```');
  refreshCodeCopy();
  assert.equal(host.querySelectorAll('.code-copy').length, 1);
  host.querySelector('.code-copy').click();
  await tick();
  assert.deepEqual(writes, ['partial', 'partial complete']);
});

test('Mermaid code tab copies source, keeps diagram and reuses the live control', async t => {
  const { dom, host, render, writes, tick } = setup(t);
  render('```mermaid\nflowchart LR\nA-->B\n```');
  const button = host.querySelector('.code-copy');
  const diagram = host.querySelector('.mermaid-svg');
  diagram.textContent = 'Rendered diagram';
  dom.window.setMermaidSource(host.querySelector('.mermaid-block'), 'flowchart LR\nA-->C');
  refreshCodeCopy();
  button.click();
  await tick();
  assert.deepEqual(writes, ['flowchart LR\nA-->C']);
  assert.equal(host.querySelector('.mermaid-svg'), diagram);
  assert.equal(diagram.textContent, 'Rendered diagram');
  assert.equal(host.querySelectorAll('.code-copy').length, 1);
});

test('clipboard rejection or missing API reports failure and allows a retry', async t => {
  const { dom, host, render, writes, tick } = setup(t);
  render('```\nretry me\n```');
  dom.window.navigator.clipboard.writeText = async () => { throw new Error('Denied'); };
  const button = host.querySelector('.code-copy');
  button.click();
  await tick();
  assert.equal(button.textContent, 'Copy failed');
  dom.window.navigator.clipboard = undefined;
  button.click();
  await tick();
  assert.equal(button.textContent, 'Copy failed');
  dom.window.navigator.clipboard = { writeText: async text => writes.push(text) };
  button.click();
  await tick();
  assert.deepEqual(writes, ['retry me']);
  assert.equal(button.textContent, 'Copied');
});

test('double clicks share one pending clipboard operation and capture text before changes', async t => {
  const { dom, host, render, tick } = setup(t);
  render('```\noriginal\n```');
  let finish;
  const values = [];
  dom.window.navigator.clipboard.writeText = text => {
    values.push(text);
    return new Promise(resolve => { finish = resolve; });
  };
  const button = host.querySelector('.code-copy');
  button.click();
  button.click();
  host.querySelector('code').textContent = 'later';
  assert.deepEqual(values, ['original']);
  assert.equal(button.getAttribute('aria-busy'), 'true');
  finish();
  await tick();
  assert.equal(button.hasAttribute('aria-busy'), false);
});

test('ignores tool output, skeletons, summaries, inline and empty code', t => {
  const { host, render } = setup(t);
  render('Inline `code` and\n```\n\n```');
  const messages = host.parentElement;
  for (const name of ['tool-node', 'skeleton-copy', 'summary-block', 'command-panel-tl']) {
    messages.insertAdjacentHTML('beforeend',
      `<div class="${name}"><div class="assistant-text"><pre><code>excluded</code></pre></div></div>`);
  }
  refreshCodeCopy();
  assert.equal(document.querySelectorAll('.code-copy').length, 0);
});

test('observer adds controls to new history; pointer press retains selection; disposal ignores pending feedback', async t => {
  const { dom, host, tick, dispose } = setup(t);
  host.innerHTML = dom.window.renderMd('```\nnew history\n```');
  await new Promise(resolve => setTimeout(resolve, 50));
  const button = host.querySelector('.code-copy');
  assert.ok(button);
  const input = document.getElementById('draft');
  input.focus();
  input.setSelectionRange(2, 5);
  const pointer = new dom.window.Event('pointerdown', { bubbles: true, cancelable: true });
  button.dispatchEvent(pointer);
  assert.equal(pointer.defaultPrevented, true);
  assert.equal(document.activeElement, input);
  assert.equal(input.selectionStart, 2);
  let finish;
  dom.window.navigator.clipboard.writeText = () => new Promise(resolve => { finish = resolve; });
  button.click();
  dispose();
  finish();
  await tick();
  assert.equal(document.querySelector('.code-copy'), null);
});
