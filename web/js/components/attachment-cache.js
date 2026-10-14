// Downloaded attachments kept in IndexedDB so reopening one skips the URL request and the download.
// A key never changes content (uploads mint a new key), so entries never go stale; the oldest-opened
// files are evicted past the size budget. Every failure just means a cache miss.
import { state } from '../state.js';
import { IMAGE_MIME_TYPES } from './image-type.js';

const DB_NAME = 'agentpeek-attachments-v1';
const STORE = 'files';
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
let dbPromise = null;

function done(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function database() {
  if (!globalThis.indexedDB) return Promise.reject(new Error('IndexedDB is unavailable'));
  if (!dbPromise) {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: 'key' }).createIndex('byLastAccess', 'lastAccessAt');
    };
    dbPromise = done(request).catch(error => { dbPromise = null; throw error; });
  }
  return dbPromise;
}

async function store(mode) {
  return (await database()).transaction(STORE, mode).objectStore(STORE);
}

const scoped = key => state.SERVER + '|' + state.KEY + '|' + key;

// Previews that open from the cache besides Office files; large PDFs still load by range uncached.
export const CACHED_PREVIEW_TYPES = {
  pdf: 'application/pdf', ...IMAGE_MIME_TYPES,
};

export function isCachedPreview(key) {
  const extension = (key || '').split('.').pop();
  return ['docx', 'pptx', 'xlsx'].includes(extension) || extension in CACHED_PREVIEW_TYPES;
}

export async function cachedAttachment(key) {
  try {
    const files = await store('readwrite');
    const entry = await done(files.get(scoped(key)));
    if (!entry) return null;
    files.put({ ...entry, lastAccessAt: Date.now() });
    return { name: entry.name, data: await entry.data.arrayBuffer() };
  } catch {
    return null;
  }
}

// `data` is a Blob (an uploaded File) or an ArrayBuffer, copied at once because the viewer may
// transfer (detach) it while the database opens.
export function cacheAttachment(key, name, data) {
  const blob = data instanceof Blob ? data : new Blob([data]);
  if (blob.size > MAX_FILE_BYTES) return;
  (async () => {
    const files = await store('readwrite');
    files.put({ key: scoped(key), name, size: blob.size, lastAccessAt: Date.now(), data: blob });
    // Newest first; everything past the budget goes. The new entry is the newest, so it stays.
    let total = 0;
    const cursor = files.index('byLastAccess').openCursor(null, 'prev');
    await new Promise((resolve, reject) => {
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) return resolve();
        total += row.value.size;
        if (total > MAX_TOTAL_BYTES) row.delete();
        row.continue();
      };
    });
  })().catch(() => {});
}
