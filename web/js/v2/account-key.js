// The account key K per server, kept in IndexedDB as a non-extractable CryptoKey (plan D2), with
// when it arrived ({ key, at }).
import { importAccountKey } from '../../../bridge/e2ee.mjs';

const memory = new Map(); // where IndexedDB is missing or blocked: this page only

function store(mode, use) {
  if (typeof indexedDB === 'undefined') return Promise.resolve(use({ get: (k) => ({ result: memory.get(k) }), put: (v, k) => memory.set(k, v) }).result);
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('baton-e2ee', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('keys');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('keys', mode);
      const request = use(tx.objectStore('keys'));
      tx.oncomplete = () => { open.result.close(); resolve(request.result); };
      tx.onerror = () => { open.result.close(); reject(tx.error); };
    };
  });
}

export const loadAccountKey = (server) => store('readonly', (keys) => keys.get(server)).catch(() => memory.get(server) || null);

export async function saveAccountKey(server, raw) {
  const saved = { key: await importAccountKey(raw), at: Date.now() };
  await store('readwrite', (keys) => keys.put(saved, server)).catch(() => memory.set(server, saved));
  return saved;
}

export const forgetAccountKey = (server) => {
  memory.delete(server);
  return store('readwrite', (keys) => keys.delete(server)).catch(() => {});
};
