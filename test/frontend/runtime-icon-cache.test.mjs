import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const indexHtml = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
const styleSource = readFileSync(new URL('../../web/css/style.css', import.meta.url), 'utf8');
const cacheSource = indexHtml.slice(indexHtml.indexOf('  var runtimeIconCacheKey ='), indexHtml.indexOf('  function runtimeIcon(s)'));
const cacheKey = 'baton-runtime-icons-v2';
const assets = {
  claude: readFileSync(new URL('../../web/public/assets/claude-code.svg', import.meta.url), 'utf8'),
  codex: readFileSync(new URL('../../web/public/assets/codex.svg', import.meta.url), 'utf8'),
};

function harness({ storage = new Map(), storageBlocked = false, fetchAsset } = {}) {
  const dom = new JSDOM('<span class="runtime-mark"><img class="runtime-icon" src="./assets/claude-code.svg"></span>'
    + '<span class="runtime-mark runtime-mark-codex"><img class="runtime-icon" src="./assets/codex.svg"></span>', { url: 'http://baton.test/index.html' });
  const requests = [];
  vm.runInNewContext(cacheSource, {
    window: dom.window,
    document: dom.window.document,
    sessionStorage: {
      getItem(key) {
        if (storageBlocked) throw new Error('Storage unavailable');
        return storage.get(key) || null;
      },
      setItem(key, value) {
        if (storageBlocked) throw new Error('Storage unavailable');
        storage.set(key, value);
      },
    },
    fetch(url, options) {
      requests.push({ url, cache: options.cache });
      if (fetchAsset) return fetchAsset(url);
      return Promise.resolve({ ok: true, text: async () => assets[url.endsWith('/codex.svg') ? 'codex' : 'claude'] });
    },
  });
  return {
    dom, requests, storage,
    source: dom.window.__runtimeIconSource,
    load(runtime) {
      const selector = runtime === 'codex' ? '.runtime-mark-codex img' : '.runtime-mark:not(.runtime-mark-codex) img';
      dom.window.document.querySelector(selector).dispatchEvent(new dom.window.Event('load'));
    },
  };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('runtime icons keep their original URLs until used and cache each loaded SVG once', async () => {
  const page = harness();
  try {
    assert.equal(page.source('claude'), './assets/claude-code.svg');
    assert.equal(page.source('codex'), './assets/codex.svg');
    assert.equal(page.requests.length, 0);
    page.load('claude');
    page.load('claude');
    page.load('codex');
    await flush();
    assert.equal(page.requests.length, 2);
    assert.ok(page.requests.every(request => request.cache === 'force-cache'));
    assert.deepEqual(JSON.parse(page.storage.get(cacheKey)), assets);
    page.load('claude');
    page.load('codex');
    assert.equal(page.requests.length, 2);
  } finally { page.dom.window.close(); }
});

test('a new document reuses both cached SVGs and the Codex mask without network requests', async () => {
  const first = harness();
  try {
    first.load('claude');
    first.load('codex');
    await flush();
    const next = harness({ storage: first.storage });
    try {
      for (const runtime of ['claude', 'codex']) {
        assert.equal(next.source(runtime), 'data:image/svg+xml,' + encodeURIComponent(assets[runtime]));
        next.load(runtime);
      }
      assert.equal(next.requests.length, 0);
      assert.equal(next.dom.window.document.documentElement.style.getPropertyValue('--runtime-codex-image'), 'url("' + next.source('codex') + '")');
      assert.match(indexHtml, /-webkit-mask:var\(--runtime-codex-image,url\("assets\/codex\.svg"\)\)/);
      assert.match(styleSource, /-webkit-mask: var\(--runtime-codex-image, url\("\.\.\/assets\/codex\.svg"\)\)/);
      assert.match(styleSource, /\n  mask: var\(--runtime-codex-image, url\("\.\.\/assets\/codex\.svg"\)\)/);
    } finally { next.dom.window.close(); }
  } finally { first.dom.window.close(); }
});

test('restoring a saved home snapshot replaces old icon URLs before attaching its nodes', () => {
  const dom = new JSDOM(indexHtml, {
    url: 'http://baton.test/index.html', runScripts: 'dangerously',
    beforeParse(window) {
      window.localStorage.setItem('_ak', window.btoa('fixture_key'));
      window.sessionStorage.setItem(cacheKey, JSON.stringify(assets));
      window.sessionStorage.setItem('baton-returning-home', '1');
      window.sessionStorage.setItem('baton-page-preview', JSON.stringify({
        topBarHtml: '<div id="top-right"><a class="top-gear"></a></div>',
        contentHtml: '<span class="runtime-mark"><img class="runtime-icon" src="./assets/claude-code.svg"></span>'
          + '<span class="runtime-mark runtime-mark-codex"><img class="runtime-icon" src="./assets/codex.svg"></span>',
      }));
      window.fetch = () => new Promise(() => {});
    },
  });
  try {
    assert.equal(dom.window.__homePreviewRestored, true);
    const images = dom.window.document.querySelectorAll('#content .runtime-icon');
    assert.equal(images[0].src, 'data:image/svg+xml,' + encodeURIComponent(assets.claude));
    assert.equal(images[1].src, 'data:image/svg+xml,' + encodeURIComponent(assets.codex));
  } finally { dom.window.close(); }
});

test('unavailable storage preserves the URL fallback and in-memory icon reuse', async () => {
  const page = harness({ storageBlocked: true });
  try {
    assert.equal(page.source('codex'), './assets/codex.svg');
    page.load('codex');
    await flush();
    assert.equal(page.source('codex'), 'data:image/svg+xml,' + encodeURIComponent(assets.codex));
    page.load('codex');
    assert.equal(page.requests.length, 1);
  } finally { page.dom.window.close(); }
});

test('invalid saved icon data is ignored', () => {
  for (const value of ['{', 'null', JSON.stringify({ codex: '<html>Error</html>', claude: 1 }), JSON.stringify({ codex: '<svg>' + ' '.repeat(16384) + '</svg>' })]) {
    const page = harness({ storage: new Map([[cacheKey, value]]) });
    try {
      assert.equal(page.source('codex'), './assets/codex.svg');
      assert.equal(page.source('claude'), './assets/claude-code.svg');
      assert.equal(page.dom.window.document.documentElement.style.getPropertyValue('--runtime-codex-image'), '');
    } finally { page.dom.window.close(); }
  }
});

test('failed icon caching does not break rendering and can retry on the next load', async () => {
  let fail = true;
  const page = harness({ fetchAsset: async () => {
    if (fail) throw new Error('offline');
    return { ok: true, text: async () => assets.claude };
  } });
  try {
    page.load('claude');
    await flush();
    assert.equal(page.source('claude'), './assets/claude-code.svg');
    assert.equal(page.storage.has(cacheKey), false);
    fail = false;
    page.load('claude');
    await flush();
    assert.equal(page.requests.length, 2);
    assert.equal(page.source('claude'), 'data:image/svg+xml,' + encodeURIComponent(assets.claude));
  } finally { page.dom.window.close(); }
});
