import assert from 'node:assert/strict';
import test from 'node:test';

let serial = 0;
async function fixture(t, fetchAsset) {
  const originalFetch = globalThis.fetch;
  const originalIndexedDB = globalThis.indexedDB;
  const requests = [];
  globalThis.indexedDB = undefined;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return fetchAsset ? fetchAsset(url, options) : new Response('asset bytes');
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.indexedDB = originalIndexedDB;
  });
  const module = await import(`../../web/js/components/pdf-assets.js?test=${++serial}`);
  return { ...module, requests };
}

test('PDF assets are lazy, share concurrent downloads, and work without persistent storage', async t => {
  const { loadPdfAsset, requests } = await fixture(t);
  assert.equal(requests.length, 0);
  const [first, second] = await Promise.all([
    loadPdfAsset('build/pdf.min.js'), loadPdfAsset('build/pdf.min.js'),
  ]);
  assert.equal(first, second);
  assert.equal(await first.text(), 'asset bytes');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(requests[0].options.cache, 'force-cache');
  assert.equal(requests[0].url, 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js');
  await loadPdfAsset('build/pdf.min.js');
  assert.equal(requests.length, 1);
});

test('failed, empty and unsuccessful downloads can be retried', async t => {
  const responses = [new Error('offline'), new Response('', { status: 503 }), new Response(''), new Response('ready')];
  const { loadPdfAsset, requests } = await fixture(t, () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  await assert.rejects(loadPdfAsset('build/pdf.min.js'), /offline/);
  await assert.rejects(loadPdfAsset('build/pdf.min.js'), /503/);
  await assert.rejects(loadPdfAsset('build/pdf.min.js'), /empty/);
  assert.equal(await (await loadPdfAsset('build/pdf.min.js')).text(), 'ready');
  assert.equal(requests.length, 4);
});

test('CSS images reuse cached blobs and optional font/CMap requests use the asset cache', async t => {
  const { loadPdfStyles, pdfDocumentOptions, requests } = await fixture(t, url => new Response(
    url.endsWith('.css')
      ? '.a{background:url("images/loading-icon.gif")} .b{mask:url(images/altText_add.svg)}'
      : 'optional asset',
  ));
  const first = await loadPdfStyles();
  assert.match(first, /url\("blob:/);
  assert.equal(await loadPdfStyles(), first);
  assert.equal(requests.length, 3);
  const cmap = new pdfDocumentOptions.CMapReaderFactory();
  const font = new pdfDocumentOptions.StandardFontDataFactory();
  assert.equal(pdfDocumentOptions.useWorkerFetch, false);
  assert.equal(pdfDocumentOptions.isEvalSupported, false);
  assert.equal((await cmap.fetch({ name: 'UniGB-UCS2-H' })).compressionType, 1);
  assert.ok(await font.fetch({ filename: 'LiberationSans-Regular.ttf' }) instanceof Uint8Array);
  await cmap.fetch({ name: 'UniGB-UCS2-H' });
  await font.fetch({ filename: 'LiberationSans-Regular.ttf' });
  assert.equal(requests.length, 5);
  assert.ok(requests.some(({ url }) => url.endsWith('/cmaps/UniGB-UCS2-H.bcmap')));
  assert.ok(requests.some(({ url }) => url.endsWith('/standard_fonts/LiberationSans-Regular.ttf')));
});

test('asset paths cannot leave the pinned distribution', async t => {
  const { loadPdfAsset, requests } = await fixture(t);
  await assert.rejects(loadPdfAsset('https://example.com/engine.js'), /Invalid/);
  await assert.rejects(loadPdfAsset('../other-version/engine.js'), /Invalid/);
  assert.equal(requests.length, 0);
});

test('missing optional CSS icons are remembered without hiding engine failures', async t => {
  const { loadPdfStyles, loadPdfAsset, requests } = await fixture(t, url => url.endsWith('.css')
    ? new Response('.a{mask:url(images/altText_add.svg)}')
    : new Response('', { status: 404 }));
  assert.match(await loadPdfStyles(), /url\("blob:/);
  await loadPdfStyles();
  assert.equal(requests.length, 2);
  await assert.rejects(loadPdfAsset('build/pdf.min.js'), /404/);
});
