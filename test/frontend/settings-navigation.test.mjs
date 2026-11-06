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
    url: 'http://baton.test/index.html',
    runScripts: 'dangerously',
    beforeParse(window) {
      window.localStorage.setItem('_ak', window.btoa('test_key'));
      window.sessionStorage.setItem('baton-returning-home', '1');
      window.sessionStorage.setItem('baton-page-preview', JSON.stringify(snapshot));
      window.fetch = () => new Promise(() => {});
    },
  });

  assert.equal(dom.window.document.getElementById('saved-home-frame')?.textContent, 'Saved content');
  assert.equal(dom.window.document.body.classList.contains('ready'), true);
  assert.equal(dom.window.__homePreviewRestored, true);
  assert.equal(dom.window.__inlineRendered, true);
  dom.window.close();
});

for (const fails of [false, true]) {
  test(`settings return keeps the gear spinning until refresh ${fails ? 'fails' : 'finishes'}`, async () => {
    let resolveActive;
    let resolveDevices;
    let rejectDevices;
    const active = new Promise(resolve => { resolveActive = resolve; });
    const devices = new Promise((resolve, reject) => { resolveDevices = resolve; rejectDevices = reject; });
    const dom = new JSDOM(indexHtml, {
      url: 'http://baton.test/index.html', runScripts: 'dangerously',
      beforeParse(window) {
        window.localStorage.setItem('_ak', window.btoa('test_key'));
        window.sessionStorage.setItem('baton-returning-home', '1');
        window.sessionStorage.setItem('baton-page-preview', JSON.stringify({
          topBarHtml: '<div id="top-right"><a class="top-gear"></a></div>',
          contentHtml: '<div id="saved-home-frame">Saved content</div>',
        }));
        window.__apiReady = Promise.resolve();
        window.api = async path => { const r = await window.fetch(new URL(path, window.location.href).href); if (r && r.ok === false) throw new Error(String(r.status)); return r && r.json ? r.json() : r; };
        window.fetch = url => url.includes('active-sessions') ? active : devices;
      },
    });
    try {
      await new Promise(resolve => setTimeout(resolve, 25));
      const refresh = dom.window.__homeLoadPromise;
      const topRight = dom.window.document.getElementById('top-right');
      assert.ok(refresh);
      assert.equal(dom.window.__homePreviewRestored, true);
      assert.equal(dom.window.__returningHome, true);
      assert.equal(topRight.classList.contains('syncing'), true);

      resolveActive({ ok: true, json: async () => ({ sessions: [], recentProjects: [] }) });
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(topRight.classList.contains('syncing'), true);

      if (fails) rejectDevices(new Error('offline'));
      else resolveDevices({ ok: true, json: async () => ({ devices: [] }) });
      await refresh;
      assert.equal(topRight.classList.contains('syncing'), false);
      assert.equal(dom.window.__returningHome, false);
      if (fails) assert.ok(dom.window.document.getElementById('saved-home-frame'));
    } finally { dom.window.close(); }
  });
}
