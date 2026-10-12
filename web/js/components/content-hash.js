// SHA-256 of an upload, which S3 verifies (same as bridge/content-hash.mjs). WebCrypto has no streaming digest,
// so hash-wasm hashes the file in slices, loaded on demand from jsDelivr like PDF.js and Mermaid.
const HASH_WASM = 'https://cdn.jsdelivr.net/npm/hash-wasm@4.12.0/dist/index.esm.min.js';
const SLICE = 4 * 1024 * 1024;
let library = null;

// Replaceable in tests, where the CDN is not reachable.
export const hashWasm = { load: () => import(/* @vite-ignore */ HASH_WASM) };

// Resolves to '' when hashing is unavailable, which uploads under a random key as before.
export async function contentHash(file) {
  try {
    library ??= hashWasm.load().catch(error => { library = null; throw error; });
    const hash = await (await library).createSHA256();
    for (let at = 0; at < file.size; at += SLICE) {
      hash.update(new Uint8Array(await file.slice(at, at + SLICE).arrayBuffer()));
    }
    return hash.digest('hex');
  } catch {
    return '';
  }
}
