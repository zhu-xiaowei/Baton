import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');

test('returning from settings restores the saved home frame during parsing', () => {
  const snapshot = {
    topBarHtml: '<div class="top-left">Saved home</div><div id="top-right"><a class="top-gear"></a></div>',
    breadcrumbHtml: '',
    breadcrumbDisplay: 'none',
    contentHtml: '<div id="saved-home-frame" data-nav="device" data-name="phone">Saved content</div>',
    scrollTop: 24,
  };

  const dom = new JSDOM(indexHtml, {
    url: 'http://agentpeek.test/index.html',
    runScripts: 'dangerously',
    beforeParse(window) {
      window.localStorage.setItem('_ak', window.btoa('test_key'));
      window.sessionStorage.setItem('agentpeek-returning-home', '1');
      window.sessionStorage.setItem('agentpeek-page-preview', JSON.stringify(snapshot));
      window.fetch = () => new Promise(() => {});
    },
  });

  assert.equal(dom.window.document.getElementById('saved-home-frame')?.textContent, 'Saved content');
  assert.equal(dom.window.document.body.classList.contains('ready'), true);
  assert.equal(dom.window.__homePreviewRestored, true);
  assert.equal(dom.window.__inlineRendered, true);
  dom.window.close();
});
