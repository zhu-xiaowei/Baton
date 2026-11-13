// End-to-end encryption shared by Bridge and App (docs/v2-accounts-e2ee-plan.md §6). The account
// key K derives every key with HKDF-SHA256. A session key comes from ECDH between the App's and the
// Bridge's per-process ephemeral P-256 keys, salted with HMAC(psk, appPub ‖ bridgePub): whoever
// swaps a public key cannot compute the salt. Sealed = nonce(12) ‖ AES-256-GCM(seq(4) ‖ flags(1) ‖ body).
// This file is the browser implementation (WebCrypto, async); e2ee-node.mjs is Bridge's synchronous twin.

import { fromBase64, toBase64 } from './direct-rpc-protocol.mjs';

const encoder = new TextEncoder();
export const info = (name) => encoder.encode('baton-e2ee/' + name);
export const WINDOW = 4096;

// The relay cannot move a ciphertext to another request, event, Session, stream or direction.
export function aadOf(dir, frame) {
  return encoder.encode(frame.kind === 'stream'
    ? `${dir}|stream|${frame.ch}|${frame.id}`
    : `${dir}|${frame.kind}|${frame.method || frame.event || ''}|${frame.requestId || frame.id || ''}|${frame.sessionId || ''}|${frame.ok ?? ''}`);
}

// Sequence numbers already opened; profile A reorders frames, so this is a window, not a counter.
// `floor`: everything up to it was seen (a session Bridge evicted and made again).
export class ReplayWindow {
  constructor(floor = 0) { this.max = this.floor = floor; this.seen = new Set(); }
  accept(seq) {
    if (seq <= this.floor || seq <= this.max - WINDOW || this.seen.has(seq)) return false;
    this.seen.add(seq);
    if (seq > this.max) {
      this.max = seq;
      if (this.seen.size > WINDOW) for (const old of this.seen) { if (old > seq - WINDOW) break; this.seen.delete(old); }
    }
    return true;
  }
}

export const sessionTag = (pubB64) => pubB64.slice(4, 16);

const subtle = () => globalThis.crypto.subtle;
const derive = (k, name, alg, usage) => subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: info(name) },
  k, alg, false, usage);
const bits = async (k, name, length = 256) => new Uint8Array(await subtle().deriveBits(
  { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: info(name) }, k, length));

export const importAccountKey = (raw) => subtle().importKey('raw', raw, 'HKDF', false, ['deriveKey', 'deriveBits']);

async function sealWith(key, plain, seq, flags, aad) {
  const head = new Uint8Array(5 + plain.length);
  new DataView(head.buffer).setUint32(0, seq);
  head[4] = flags;
  head.set(plain, 5);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, head));
  const out = new Uint8Array(12 + body.length);
  out.set(nonce);
  out.set(body, 12);
  return out;
}

async function openWith(key, sealed, aad) {
  try {
    const plain = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: sealed.subarray(0, 12), additionalData: aad },
      key, sealed.subarray(12)));
    return { seq: new DataView(plain.buffer).getUint32(0), flags: plain[4], body: plain.subarray(5) };
  } catch { return null; }
}

// The App's keys for one K: per-process ephemeral key, sessions with Bridges, notification key.
export async function appKeys(k, since = 0) {
  const psk = await derive(k, 'psk', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']);
  const pair = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pubRaw = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
  const pub = toBase64(pubRaw);
  const sessions = new Map(); // bridge public key → Promise<session>
  let files = null;
  const session = async (bridgePub) => {
    const peerRaw = fromBase64(bridgePub);
    const peer = await subtle().importKey('raw', peerRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const secret = await subtle().deriveBits({ name: 'ECDH', public: peer }, pair.privateKey, 256);
    const both = new Uint8Array(pubRaw.length + peerRaw.length);
    both.set(pubRaw);
    both.set(peerRaw, pubRaw.length);
    const salt = await subtle().sign('HMAC', psk, both);
    const ikm = await subtle().importKey('raw', secret, 'HKDF', false, ['deriveKey']);
    const key = await subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: info('session') }, ikm,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    let seq = 0;
    const window = new ReplayWindow();
    return {
      seal: async (frame, body, flags = 0) => toBase64(await sealWith(key, body, ++seq, flags, aadOf('a', frame))),
      open: async (frame, text) => {
        const out = await openWith(key, fromBase64(text), aadOf('b', frame));
        return out && window.accept(out.seq) ? out : null;
      },
    };
  };
  return {
    pub, tag: sessionTag(pub), fp: hex(await bits(k, 'fp', 64)),
    session: (bridgePub) => {
      if (!sessions.has(bridgePub)) sessions.set(bridgePub, session(bridgePub));
      return sessions.get(bridgePub);
    },
    notifyKey: async () => toBase64(await bits(k, 'notify')),
    openAlert: async (event) => {
      try {
        const sealed = fromBase64(event.e);
        const key = await derive(k, 'notify', { name: 'AES-GCM', length: 256 }, ['decrypt']);
        const plain = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: sealed.subarray(0, 12),
          additionalData: encoder.encode(event.eventId || '') }, key, sealed.subarray(12)));
        return { ...event, ...JSON.parse(new TextDecoder().decode(plain.subarray(5))) };
      } catch { return event; }
    },
    files: () => (files ||= Promise.all([derive(k, 'file', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']),
      derive(k, 'file-id', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign'])]).then(([key, id]) => ({ key, id, since }))),
  };
}

// Accounts and pairing (docs/v2-accounts-design.md §5). The server knows accountId and hash(joinSecret);
// K travels sealed under `t`, which only the QR code carries, bound to its pairing code.
const b64url = (bytes) => toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = (bytes) => Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join('');
const hkdfKey = async (raw) => subtle().importKey('raw', raw, 'HKDF', false, ['deriveKey']);
const gcm = (k, name, usage) => derive(k, name, { name: 'AES-GCM', length: 256 }, [usage]);

export async function accountOf(raw) {
  const k = await importAccountKey(raw);
  return { accountId: hex(await bits(k, 'account', 64)), joinSecret: b64url(await bits(k, 'join')) };
}

// One 32-byte key sealed with AES-GCM: nonce ‖ ciphertext ‖ tag, base64.
async function sealKey(key, plain, aad) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(aad) }, key, plain));
  const out = new Uint8Array(12 + body.length);
  out.set(nonce);
  out.set(body, 12);
  return toBase64(out);
}

async function openKey(key, sealed, aad) {
  try {
    const bytes = fromBase64(sealed);
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: encoder.encode(aad) },
      key, bytes.subarray(12)));
  } catch { return null; }
}

export const sealPair = async (t, raw, code) => sealKey(await gcm(await hkdfKey(t), 'pair', 'encrypt'), raw, code);
export const openPair = async (t, sealed, code) => openKey(await gcm(await hkdfKey(t), 'pair', 'decrypt'), sealed, code);

// Key rotation (design §8): the App that removes a device seals K' under the old K, keyed by the old
// fingerprint; every device still holding the old K opens it from /devices. `k` is the CryptoKey.
export const fingerprint = async (k) => hex(await bits(k, 'fp', 64));
export const sealRotation = async (k, rawNext, fp) => sealKey(await gcm(k, 'rotate', 'encrypt'), rawNext, fp);
export const openRotation = async (k, sealed, fp) => openKey(await gcm(k, 'rotate', 'decrypt'), sealed, fp);
