// Content ID shared with the Bridge (bridge/content-hash.mjs): SHA-256 over the SHA-256 of each 4 MB block,
// first 32 hex digits. Blocks keep memory flat, since WebCrypto has no streaming digest.
const BLOCK = 4 * 1024 * 1024;

async function digest(data) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

// Resolves to '' when hashing is unavailable (no WebCrypto outside secure contexts), which uploads as before.
export async function contentHash(file) {
  try {
    const count = Math.max(1, Math.ceil(file.size / BLOCK));
    const blocks = new Uint8Array(count * 32);
    for (let i = 0; i < count; i++) {
      blocks.set(await digest(await file.slice(i * BLOCK, (i + 1) * BLOCK).arrayBuffer()), i * 32);
    }
    return [...(await digest(blocks)).slice(0, 16)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return '';
  }
}
