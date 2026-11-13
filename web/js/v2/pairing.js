// Pairing links (docs/v2-accounts-design.md §5): `#c=` adds this App to the account that made it, `#j=` is a
// computer waiting to join. A signed-in App never seals K itself (it is not extractable, plan D2): an
// online computer of the account does it (`pair_invite`, `pair_approve`).
import { fromBase64 } from '../../../bridge/direct-rpc-protocol.mjs';
import { accountOf, fingerprint, openPair, sealPair, sealRotation } from '../../../bridge/e2ee.mjs';
import { state } from '../state.js';
import { loadAccountKey, saveAccountKey } from './account-key.js';
import { cachedOnlineDevices, devices, request } from './direct-transport.js';

export function parseLink(text) {
  let url;
  try { url = new URL(String(text).trim()); } catch { return null; }
  const params = new URLSearchParams(url.hash.slice(1));
  const kind = params.has('j') ? 'j' : params.has('c') ? 'c' : '';
  const t = params.get('t');
  if (!kind || !t) return null;
  return { text: url.href, kind, code: params.get(kind), t: fromBase64(t.replace(/-/g, '+').replace(/_/g, '/')),
    server: url.origin + url.pathname.replace(/\/[^/]*$/, '') };
}

export function deviceName() {
  const ua = navigator.userAgent;
  const native = window.__TAURI_INTERNALS__;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad|Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'Linux';
  return native ? os : `Browser (${os})`;
}

async function post(server, path, body, key) {
  const response = await fetch(server + path, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
  });
  const reply = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(reply.detail || reply.error || 'Connection failed');
  return reply;
}

// Signed out: an invite joins its account; a computer's code starts a new account with that computer.
export async function signInWithLink(link) {
  let token, raw, added = '';
  if (link.kind === 'c') {
    const reply = await post(link.server, '/api/pair/claim', { code: link.code, deviceName: deviceName() });
    raw = await openPair(link.t, reply.sealed, link.code);
    if (raw?.length !== 32 || (await accountOf(raw)).accountId !== reply.accountId) throw new Error('This code does not match its account.');
    token = reply.token;
  } else {
    raw = crypto.getRandomValues(new Uint8Array(32));
    const { accountId, joinSecret } = await accountOf(raw);
    token = (await post(link.server, '/api/account/register', { accountId, joinSecret, deviceName: deviceName() })).token;
    added = (await post(link.server, '/api/pair/approve', { code: link.code, sealed: await sealPair(link.t, raw, link.code) }, token)).deviceName;
  }
  await saveAccountKey(link.server, raw);
  return { token, added };
}

// Signed in: an online computer of this account seals K for the new device.
export async function viaComputer(method, params = {}) {
  let online = cachedOnlineDevices();
  if (!online.length) {
    await devices();
    online = cachedOnlineDevices();
  }
  if (!online.length) throw new Error('Turn on one of your computers to add a device.');
  return request(online[0], method, params);
}

// After removing a computer: a new K', which every remaining device takes from /devices (design §8).
export async function rotateAccountKey() {
  const saved = await loadAccountKey(state.SERVER);
  if (!saved?.key) return;
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const fp = await fingerprint(saved.key);
  await post(state.SERVER, '/api/account/rotate', {
    joinSecret: (await accountOf(raw)).joinSecret, fp, sealed: await sealRotation(saved.key, raw, fp),
  }, state.KEY);
  await devices();
}

export async function recoverAccount(server, raw) {
  const { token } = await post(server, '/api/account/recover', { joinSecret: (await accountOf(raw)).joinSecret, deviceName: deviceName() });
  await saveAccountKey(server, raw);
  return token;
}
