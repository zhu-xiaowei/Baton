import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createTestServer } from './helpers/vite.mjs';

async function setup(t) {
  const dom = new JSDOM('<body><div class="mermaid-block" style="background-color:rgb(22,27,34)">'
    + '<div class="mermaid-head"><button class="mermaid-zoom"></button></div>'
    + '<div class="mermaid-src">flowchart LR; A-->B</div><div class="mermaid-svg">'
    + '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100">'
    + '<text x="10" y="30" style="fill:red">中文 → 测试</text>'
    + '<script>bad()</script><a href="javascript:bad()" onclick="bad()"><text>link</text></a>'
    + '</svg></div></div></body>', { url: 'https://test/', pretendToBeVisual: true, runScripts: 'outside-only' });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), XMLSerializer: dom.window.XMLSerializer,
  });
  const vite = await createTestServer({
    root: path.resolve(import.meta.dirname, '../../web'), logLevel: 'silent',
    appType: 'custom', server: { middlewareMode: true, hmr: false },
  });
  t.after(async () => { await vite.close(); dom.window.close(); delete window.__TAURI_INTERNALS__; });
  return { dom, exports: await vite.ssrLoadModule('/js/components/diagram-export.js') };
}

test('SVG export preserves Chinese text, colors and original bounds, without active markup', async t => {
  const { exports } = await setup(t);
  const snapshot = exports.snapshotDiagram(document.querySelector('svg'), '0 0 600 200');
  const xml = Buffer.from(snapshot.file.url.split(',')[1], 'base64').toString('utf8');
  assert.match(xml, /中文 → 测试/);
  assert.match(xml, /viewBox="0 0 600 200"/);
  assert.match(xml, /fill: (?:red|rgb\(255, 0, 0\))/);
  assert.doesNotMatch(xml, /<script|onclick=|javascript:/);
  assert.equal(snapshot.width, 600);
  assert.equal(snapshot.height, 200);
  assert.equal(snapshot.background, 'rgb(22, 27, 34)');
  assert.throws(() => exports.localImageFile('data:text/html;base64,YQ=='));
  assert.throws(() => exports.localImageFile('data:image/png;base64,%%%'));
  assert.throws(() => exports.localImageFile('data:image/png;base64,' + 'A'.repeat(44_739_248)), /32 MiB/);
});

test('SVG export sends local original bytes once, exposes failures and can retry', async t => {
  const { exports } = await setup(t);
  const calls = [];
  let fail = true;
  window.__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback() {},
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (fail) throw new Error('Disk full');
      return { status: 'saved' };
    } };
  const menu = exports.diagramExport(() => document.querySelector('svg'));
  document.body.append(menu);
  const button = [...menu.querySelectorAll('button')].find(button => button.textContent === 'SVG');
  const status = menu.querySelector('[role=status]');
  button.click();
  button.click();
  assert.equal(button.disabled, true);
  for (let i = 0; button.disabled && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls.length, 1);
  assert.equal(status.textContent, 'Disk full');
  assert.equal(calls[0].command, 'plugin:file-download|download');
  assert.match(Buffer.from(calls[0].args.url.split(',')[1], 'base64').toString('utf8'), /中文/);
  fail = false;
  button.click();
  for (let i = 0; button.disabled && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls.length, 2);
  assert.equal(status.textContent, 'Saved to Downloads.');
});

test('fullscreen export retains full bounds after zoom or pan', async t => {
  const { dom } = await setup(t);
  dom.window.matchMedia = () => ({ matches: false });
  dom.window.eval(fs.readFileSync(new URL('../../web/js/components/mermaid.js', import.meta.url), 'utf8'));
  dom.window.openMermaidFullscreen(document.querySelector('.mermaid-zoom'));
  const fullSvg = document.querySelector('.mermaid-fs-stage svg');
  fullSvg.setAttribute('viewBox', '100 50 50 20');
  const calls = [];
  window.__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback() {},
    invoke: async (command, args) => { calls.push({ command, args }); return { status: 'saved' }; } };
  const button = [...document.querySelectorAll('.diagram-export-fullscreen button')]
    .find(button => button.textContent === 'SVG');
  button.click();
  for (let i = 0; button.disabled && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const xml = Buffer.from(calls[0].args.url.split(',')[1], 'base64').toString('utf8');
  assert.match(xml, /viewBox="0 0 300 100"/);
  assert.ok(document.querySelector('.mermaid-fs-overlay'), 'export does not close the viewer');
  dom.window.closeMermaidFullscreen();
});
