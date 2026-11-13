// The recovery phrase is K as 24 BIP-39 words: 256 bits + the first byte of SHA-256(K) = 24 × 11 bits.
import WORDS from './words.js';

const checksum = async (raw) => new Uint8Array(await crypto.subtle.digest('SHA-256', raw))[0];

function bitsOf(bytes) {
  return Array.from(bytes, (byte) => byte.toString(2).padStart(8, '0')).join('');
}

export async function toPhrase(raw) {
  const bits = bitsOf(raw) + bitsOf([await checksum(raw)]);
  return Array.from({ length: 24 }, (_, i) => WORDS[parseInt(bits.slice(i * 11, i * 11 + 11), 2)]).join(' ');
}

// K, or null when the text is not 24 known words with a matching checksum.
export async function fromPhrase(text) {
  const words = String(text).trim().toLowerCase().split(/\s+/);
  const indexes = words.map((word) => WORDS.indexOf(word));
  if (words.length !== 24 || indexes.includes(-1)) return null;
  const bits = indexes.map((index) => index.toString(2).padStart(11, '0')).join('');
  const raw = Uint8Array.from({ length: 32 }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2));
  return parseInt(bits.slice(256), 2) === await checksum(raw) ? raw : null;
}
