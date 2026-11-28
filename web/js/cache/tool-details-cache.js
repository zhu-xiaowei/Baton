// Full tool bodies and thinking text kept in IndexedDB: they never change once written, so a copy is
// used without asking the Bridge again. Least recently opened first out, 20 MB in total, nothing
// above 10 MB kept. Any failure is a plain miss.
const DB_NAME = 'baton-tool-details-v1';
const STORE = 'details';
const MAX_TOTAL = 20 * 1024 * 1024;
const MAX_ITEM = 10 * 1024 * 1024;
let opening = null;

function open() {
  opening ||= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'key' }).createIndex('at', 'at');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((error) => { opening = null; throw error; });
  return opening;
}

function done(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(transaction.error);
  });
}

// Without IndexedDB (tests, some embedded views) the request goes out at once.
export const toolDetailCacheAvailable = typeof indexedDB !== 'undefined';

export async function readToolDetail(key) {
  try {
    const db = await open();
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    const record = await new Promise((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (record) store.put({ ...record, at: Date.now() });
    await done(transaction);
    return record?.value || null;
  } catch {
    return null;
  }
}

export async function writeToolDetail(key, value) {
  try {
    const size = JSON.stringify(value).length * 2;
    if (size > MAX_ITEM) return;
    const db = await open();
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    store.put({ key, value, size, at: Date.now() });
    // Newest first: whatever no longer fits in the budget goes.
    let total = 0;
    store.index('at').openCursor(null, 'prev').onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) return;
      total += cursor.value.size || 0;
      if (total > MAX_TOTAL) cursor.delete();
      cursor.continue();
    };
    await done(transaction);
  } catch {}
}
