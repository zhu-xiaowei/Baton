// Bridge's synchronous implementation of e2ee.mjs (same keys and format), so frames keep their order.
import { createCipheriv, createDecipheriv, createECDH, createHmac, hkdfSync, randomBytes } from 'crypto';
import { ReplayWindow, aadOf, info, sessionTag } from './e2ee.mjs';

const MAX_SESSIONS = 64;
const hkdf = (ikm, name, length = 32, salt = Buffer.alloc(0)) => Buffer.from(hkdfSync('sha256', ikm, salt, info(name), length));

export function seal(key, body, seq, flags, aad) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce).setAAD(aad);
  const head = Buffer.alloc(5);
  head.writeUInt32BE(seq);
  head[4] = flags;
  return Buffer.concat([nonce, cipher.update(head), cipher.update(body), cipher.final(), cipher.getAuthTag()]);
}

export function open(key, sealed, aad) {
  if (sealed.length < 33) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12)).setAAD(aad);
    decipher.setAuthTag(sealed.subarray(-16));
    const plain = Buffer.concat([decipher.update(sealed.subarray(12, -16)), decipher.final()]);
    return { seq: plain.readUInt32BE(0), flags: plain[4], body: plain.subarray(5) };
  } catch { return null; }
}

// K (32 bytes) → this Bridge process's keys; sessions are found by the App's public key or its tag.
// `since`: when K arrived (files written before it are read as they are for a while).
// `exhausted()`: too many evicted sessions to remember; the caller makes new keys (a new ECDH key, so
// none of the forgotten sessions can be made again).
export function bridgeKeys(k, since = 0, exhausted = () => {}) {
  const psk = hkdf(k, 'psk');
  const ecdh = createECDH('prime256v1');
  const pubRaw = ecdh.generateKeys();
  const sessions = new Map(); // tag → session, most recently used last
  // An evicted session's replay floor and sequence, so it resumes when its App returns.
  const retired = new Map();
  let files = null;
  const touch = (tag) => {
    const found = sessions.get(tag);
    if (found) { sessions.delete(tag); sessions.set(tag, found); }
    return found || null;
  };
  // A session is kept only once a frame sealed with it opened: nobody without K can make one.
  const keep = (tag, made) => {
    sessions.set(tag, made);
    retired.delete(tag);
    if (sessions.size <= MAX_SESSIONS) return;
    const [old, evicted] = sessions.entries().next().value;
    sessions.delete(old);
    retired.set(old, evicted.state());
    if (retired.size > 4096) exhausted();
  };
  const session = (appPub) => {
    const tag = sessionTag(appPub);
    const found = touch(tag);
    if (found) return found;
    let key;
    try {
      const peer = Buffer.from(appPub, 'base64');
      const salt = createHmac('sha256', psk).update(Buffer.concat([peer, pubRaw])).digest();
      key = hkdf(ecdh.computeSecret(peer), 'session', 32, salt);
    } catch { return null; }
    const past = retired.get(tag);
    let seq = past?.seq || 0;
    const window = new ReplayWindow(past?.floor || 0);
    const made = {
      tag,
      seal: (frame, body, flags = 0) => seal(key, body, ++seq, flags, aadOf('b', frame)).toString('base64'),
      open: (frame, text) => {
        const out = open(key, Buffer.from(String(text), 'base64'), aadOf('a', frame));
        if (!out || !window.accept(out.seq)) return null;
        if (sessions.get(tag) !== made) keep(tag, made);
        return out;
      },
      state: () => ({ floor: window.max, seq }),
    };
    return made;
  };
  return {
    pub: pubRaw.toString('base64'),
    fp: fingerprint(k),
    session,
    byTag: touch,
    notifyKey: hkdf(k, 'notify'),
    // For transfer-store.mjs, which seals files with WebCrypto on both sides.
    files: () => (files ||= Promise.all([
      crypto.subtle.importKey('raw', hkdf(k, 'file'), 'AES-GCM', false, ['encrypt', 'decrypt']),
      crypto.subtle.importKey('raw', hkdf(k, 'file-id'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])]).then(([key, id]) => ({ key, id, since }))),
  };
}

// Synchronous twins of e2ee.mjs accountOf / sealPair / openPair.
export const accountOf = (k) => ({ accountId: hkdf(k, 'account', 8).toString('hex'), joinSecret: hkdf(k, 'join').toString('base64url'), fp: fingerprint(k) });

// One 32-byte key sealed with AES-GCM: nonce ‖ ciphertext ‖ tag, base64.
function sealKey(key, plain, aad) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce).setAAD(Buffer.from(aad));
  return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]).toString('base64');
}

function openKey(key, sealed, aad) {
  try {
    const bytes = Buffer.from(sealed, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)).setAAD(Buffer.from(aad));
    decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
  } catch { return null; }
}

export const sealPair = (t, k, code) => sealKey(hkdf(t, 'pair'), k, code);
export const openPair = (t, sealed, code) => openKey(hkdf(t, 'pair'), sealed, code);
export const fingerprint = (k) => hkdf(k, 'fp', 8).toString('hex');
// `fp`: the old K's fingerprint, under which K' was sealed.
export const openRotation = (k, sealed, fp) => openKey(hkdf(k, 'rotate'), sealed, fp);
