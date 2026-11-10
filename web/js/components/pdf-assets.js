// Keep the existing viewer version; download it only when a PDF is opened.
// IndexedDB also works on native WebView origins, where CacheStorage may not.
export const PDF_ASSET_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/';
const DATABASE = 'baton-pdf-assets-v1';
const STORE = 'assets';
const assets = new Map();
const urls = new Map();
let databasePromise;

function database() {
  if (!globalThis.indexedDB) return Promise.reject(new Error('IndexedDB is unavailable'));
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('PDF asset cache is blocked'));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); databasePromise = null; };
        resolve(db);
      };
    }).catch(error => { databasePromise = null; throw error; });
  }
  return databasePromise;
}

async function cachedAsset(url) {
  try {
    const db = await database();
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(url);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch { return null; }
}

async function cacheAsset(url, blob) {
  try {
    const db = await database();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.oncomplete = resolve;
      transaction.onabort = transaction.onerror = () => reject(transaction.error);
      transaction.objectStore(STORE).put(blob, url);
    });
  } catch { /* Storage restrictions must not prevent online previews. */ }
}

export function loadPdfAsset(path) {
  const url = new URL(path, PDF_ASSET_BASE).href;
  if (!url.startsWith(PDF_ASSET_BASE)) return Promise.reject(new Error('Invalid PDF asset path'));
  if (!assets.has(url)) {
    const pending = (async () => {
      const cached = await cachedAsset(url);
      if (cached instanceof Blob && cached.size) return cached;
      const response = await fetch(url, { cache: 'force-cache', credentials: 'omit' });
      // This distribution's CSS also references missing, unused editor icons.
      // Remember a transparent image for a definite 404 so they neither break
      // document preview nor get requested again on every application start.
      const missingIcon = response.status === 404 && path.startsWith('web/images/');
      if (!response.ok && !missingIcon) throw new Error(`PDF asset download failed (${response.status})`);
      const blob = missingIcon
        ? new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: 'image/svg+xml' })
        : await response.blob();
      if (!blob.size) throw new Error('PDF asset download was empty');
      await cacheAsset(url, blob);
      return blob;
    })().catch(error => { assets.delete(url); throw error; });
    assets.set(url, pending);
  }
  return assets.get(url);
}

// These small, shared resources live as long as the page. Workers themselves
// belong to each preview and are released when it closes.
export function pdfAssetUrl(path) {
  if (!urls.has(path)) {
    urls.set(path, loadPdfAsset(path).then(blob => URL.createObjectURL(blob))
      .catch(error => { urls.delete(path); throw error; }));
  }
  return urls.get(path);
}

export async function loadPdfStyles() {
  const css = await (await loadPdfAsset('web/pdf_viewer.css')).text();
  const references = [...css.matchAll(/url\((["']?)images\/([^)"']+)\1\)/g)];
  const replacements = await Promise.all(references.map(async match => [
    match[0], `url("${await pdfAssetUrl('web/images/' + match[2])}")`,
  ]));
  return replacements.reduce((text, [from, to]) => text.split(from).join(to), css);
}

// Route the worker's optional font/CMap requests through the same disk cache.
export const pdfDocumentOptions = {
  useWorkerFetch: false,
  isEvalSupported: false,
  CMapReaderFactory: class {
    async fetch({ name }) {
      return {
        cMapData: new Uint8Array(await (await loadPdfAsset(`cmaps/${name}.bcmap`)).arrayBuffer()),
        compressionType: 1, // PDF.js CMapCompressionType.BINARY
      };
    }
  },
  StandardFontDataFactory: class {
    async fetch({ filename }) {
      return new Uint8Array(await (await loadPdfAsset(`standard_fonts/${filename}`)).arrayBuffer());
    }
  },
};
