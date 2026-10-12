// SHA-256 of an upload, which S3 verifies (same as bridge/content-hash.mjs). WebCrypto has no streaming digest,
// so hash-wasm hashes the file in slices; its SHA-256 is a small chunk loaded on the first upload.
const SLICE = 4 * 1024 * 1024;

// Resolves to '' when hashing is unavailable, which uploads under a random key as before.
export async function contentHash(file, signal) {
  try {
    const { createSHA256 } = await import('./sha256.js');
    const hash = await createSHA256();
    for (let at = 0; at < file.size; at += SLICE) {
      signal?.throwIfAborted();
      hash.update(new Uint8Array(await file.slice(at, at + SLICE).arrayBuffer()));
    }
    return hash.digest('hex');
  } catch {
    return '';
  }
}
