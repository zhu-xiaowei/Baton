// End-to-end encryption shared by Bridge and App (docs/v2-accounts-e2ee-plan.md §6). The account
// key K derives every key with HKDF-SHA256. A session key comes from ECDH between the App's and the
// Bridge's per-process ephemeral P-256 keys, salted with HMAC(psk, appPub ‖ bridgePub): whoever
// swaps a public key cannot compute the salt. Sealed = nonce(12) ‖ AES-256-GCM(seq(4) ‖ flags(1) ‖ body).
// This file is the browser implementation (WebCrypto, async); e2ee-node.mjs is Bridge's synchronous twin.

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
export class ReplayWindow {
  constructor() { this.max = 0; this.seen = new Set(); }
  accept(seq) {
    if (seq <= this.max - WINDOW || this.seen.has(seq)) return false;
    this.seen.add(seq);
    if (seq > this.max) {
      this.max = seq;
      if (this.seen.size > WINDOW) for (const old of this.seen) { if (old > seq - WINDOW) break; this.seen.delete(old); }
    }
    return true;
  }
}

export const sessionTag = (pubB64) => pubB64.slice(4, 16);

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const subtle = () => globalThis.crypto.subtle;
const derive = (k, name, alg, usage) => subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: info(name) },
  k, alg, false, usage);
const bits = async (k, name, length = 256) => new Uint8Array(await subtle().deriveBits(
  { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: info(name) }, k, length));
const hexOf = (bytes) => Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join('');

export const importAccountKey = (raw) => subtle().importKey('raw', raw, 'HKDF', false, ['deriveKey', 'deriveBits']);
export const fingerprint = async (k) => hexOf(await bits(k, 'fp', 64));

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
export async function appKeys(k) {
  const psk = await derive(k, 'psk', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']);
  const pair = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pubRaw = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
  const pub = b64(pubRaw);
  const sessions = new Map(); // bridge public key → Promise<session>
  const session = async (bridgePub) => {
    const peerRaw = unb64(bridgePub);
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
      seal: async (frame, body, flags = 0) => b64(await sealWith(key, body, ++seq, flags, aadOf('a', frame))),
      open: async (frame, text) => {
        const out = await openWith(key, unb64(text), aadOf('b', frame));
        return out && window.accept(out.seq) ? out : null;
      },
    };
  };
  return {
    pub, tag: sessionTag(pub), fp: await fingerprint(k),
    session: (bridgePub) => {
      if (!sessions.has(bridgePub)) sessions.set(bridgePub, session(bridgePub));
      return sessions.get(bridgePub);
    },
    notifyKey: async () => b64(await bits(k, 'notify')),
  };
}
