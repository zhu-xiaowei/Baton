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
  if (/iPhone|Android/.test(ua)) return ua.match(/iPhone|Android/)[0];
  if (/iPad|Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return 'iPad';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'Linux';
  return window.__TAURI_INTERNALS__ ? os : `Browser (${os})`;
}

async function post(server, path, body, key) {
  const response = await fetch(server + path, { method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...(key ? { 'x-api-key': key } : {}) } });
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
    // The server names the account's current key (`head`, a fingerprint): K must be that key.
    if (raw?.length !== 32 || (reply.head && (await accountOf(raw)).fp !== reply.head)) throw new Error('This code does not match its account.');
    token = reply.token;
  } else {
    raw = crypto.getRandomValues(new Uint8Array(32));
    token = (await post(link.server, '/api/account/register', { ...await accountOf(raw), deviceName: deviceName() })).token;
    added = (await post(link.server, '/api/pair/approve', { code: link.code, sealed: await sealPair(link.t, raw, link.code) }, token)).deviceName;
  }
  await saveAccountKey(link.server, raw);
  return { token, added };
}

export async function recoverAccount(server, raw) {
  const { token } = await post(server, '/api/account/recover', { joinSecret: (await accountOf(raw)).joinSecret, deviceName: deviceName() });
  await saveAccountKey(server, raw);
  return token;
}

// Signed in: an online computer of this account seals K for the new device.
export async function viaComputer(method, params = {}) {
  const online = cachedOnlineDevices().length ? cachedOnlineDevices() : (await devices(), cachedOnlineDevices());
  if (!online.length) throw new Error('Turn on one of your computers to add a device.');
  return request(online[0], method, params);
}

// A device leaves (`path`: a computer or another App). A hosted account replaces K in the same request: K'
// sealed under the current K, which the App first catches up with; then it takes K' from the chain like every
// other device. Self-hosted accounts (API key) only revoke.
export async function removeDevice(path, body) {
  let rotation = null;
  if ((await devices()).hosted) {
    const { key } = await loadAccountKey(state.SERVER);
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const { joinSecret, fp: next } = await accountOf(raw);
    const fp = await fingerprint(key);
    rotation = { joinSecret, fp, next, sealed: await sealRotation(key, raw, fp) };
  }
  await post(state.SERVER, path, { ...body, rotation }, state.KEY);
  await devices();
}
