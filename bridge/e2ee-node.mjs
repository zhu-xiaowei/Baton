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
export function bridgeKeys(k) {
  const psk = hkdf(k, 'psk');
  const ecdh = createECDH('prime256v1');
  const pubRaw = ecdh.generateKeys();
  const sessions = new Map(); // tag → session
  const session = (appPub) => {
    const tag = sessionTag(appPub);
    let found = sessions.get(tag);
    if (found) { sessions.delete(tag); sessions.set(tag, found); return found; }
    let key;
    try {
      const peer = Buffer.from(appPub, 'base64');
      const salt = createHmac('sha256', psk).update(Buffer.concat([peer, pubRaw])).digest();
      key = hkdf(ecdh.computeSecret(peer), 'session', 32, salt);
    } catch { return null; }
    let seq = 0;
    const window = new ReplayWindow();
    found = {
      tag,
      seal: (frame, body, flags = 0) => seal(key, body, ++seq, flags, aadOf('b', frame)).toString('base64'),
      open: (frame, text) => {
        const out = open(key, Buffer.from(String(text), 'base64'), aadOf('a', frame));
        return out && window.accept(out.seq) ? out : null;
      },
    };
    sessions.set(tag, found);
    if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    return found;
  };
  return {
    pub: pubRaw.toString('base64'),
    fp: hkdf(k, 'fp', 8).toString('hex'),
    session,
    byTag: (tag) => sessions.get(tag) || null,
    notifyKey: hkdf(k, 'notify'),
  };
}
