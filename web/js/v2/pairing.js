// Pairing links (docs/v2-accounts-design.md §5): `#c=` adds this App to the account that made it, `#j=` is a
// computer waiting to join. A signed-in App never seals K itself (it is not extractable, plan D2): an
// online computer of the account does it (`pair_invite`, `pair_approve`).
import { fromBase64 } from '../../../bridge/direct-rpc-protocol.mjs';
import { accountOf, joinSecretOf, openPair, openPhrase, openRecovery, pairCode, recoveryOf, sealPair } from '../../../bridge/e2ee.mjs';
import { defaultServer, state } from '../state.js';
import { loadAccountKey, saveAccountKey } from './account-key.js';
import { cachedOnlineDevices, devices, request } from './direct-transport.js';
import { viaEntry, vouched } from '../../../bridge/entry.mjs';
import { startEntry } from './entry.js';

export function parseLink(text) {
  let url;
  try { url = new URL(String(text).trim()); } catch { return null; }
  const params = new URLSearchParams(url.hash.slice(1));
  const kind = params.has('j') ? 'j' : params.has('c') ? 'c' : '';
  // `p`, the link's one secret, is the value itself; older links carry the code there and the secret in `t`.
  const t = params.get('t') || params.get(kind);
  if (!kind || !t) return null;
  return { text: url.href, kind, code: params.get('t') ? params.get(kind) : null, t: fromBase64(t.replace(/-/g, '+').replace(/_/g, '/')),
    name: params.get('n') || '', // a computer's display name (the server knows it by a random ID)
    // A link to this very page is served by this deployment, whose API server it knows; older links name theirs (`s`).
    server: url.origin === globalThis.location?.origin ? defaultServer() : (/^https:\/\//.test(params.get('s') || '') && params.get('s').replace(/\/$/, '')) || '' };
}

// Another deployment's link (the native App, a pasted link): its page names its API server, or is served by it.
async function serverOf(link) {
  const page = new URL('index.html', link.text);
  const html = await fetch(page).then((response) => (response.ok ? response.text() : ''), () => '');
  return (/<meta name="baton-api" content="(https:\/\/[^"]+)"/.exec(html)?.[1] || page.origin + page.pathname.replace(/\/[^/]*$/, '')).replace(/\/$/, '');
}

// "iPhone" for the App, "Safari on iPhone" for a browser: how the account's device list tells them apart.
export function deviceName() {
  const ua = navigator.userAgent;
  const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const os = /iPhone/.test(ua) ? 'iPhone' : ipad ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'Linux';
  if (window.__TAURI_INTERNALS__) return os;
  const browser = /EdgiOS|Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${browser} on ${os}`;
}

// This App's own random id (kept until its storage is cleared): joining again replaces its earlier entry.
const me = () => ({ deviceName: deviceName(), install: localStorage.baton_install ||= Array.from(crypto.getRandomValues(new Uint8Array(16)),
  (byte) => byte.toString(16).padStart(2, '0')).join('') });  // not randomUUID: iOS 14 WebViews lack it

async function post(server, path, body, key) {
  const send = (url) => fetch(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json',
    ...(key ? { 'x-api-key': key } : {}), ...(url !== server + path && vouched.token ? { 'x-baton-ip': vouched.token } : {}) } });
  // Through the relay where it is the entry: a new account is then placed near it (server/core/accounts.mjs).
  const entry = await startEntry(server);
  let response = await send(viaEntry(server + path, server, entry));
  // The relay's one shared address may have used up a per-address limit: this device's own address then.
  if (response.status === 429 && entry) response = await send(server + path);
  const reply = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(reply.detail || reply.error || 'Connection failed'), { status: response.status });
  return reply;
}

// Signed out: an invite joins its account; a computer's code starts a new account with that computer.
export async function signInWithLink(link) {
  let token, raw, added = '';
  const server = link.server || await serverOf(link);
  const code = link.code ?? await pairCode(link.t);
  if (link.kind === 'c') {
    const reply = await post(server, '/api/pair/claim', { code, ...me() });
    raw = await openPair(link.t, reply.sealed, code);
    // The server names the account's current key (`head`, a fingerprint): K must be that key.
    if (raw?.length !== 32 || (reply.head && (await accountOf(raw)).fp !== reply.head)) throw new Error('This code does not match its account.');
    token = reply.token;
  } else {
    // 425: the server placed the new account away from this computer's region; another key is another account id.
    for (let retry = 0; !token; retry++) {
      raw = crypto.getRandomValues(new Uint8Array(32));
      const recovery = await recoveryOf(crypto.getRandomValues(new Uint8Array(32)), raw);
      token = (await post(server, '/api/account/register', { ...await accountOf(raw), ...recovery, ...me(), code, retry: String(retry) })
        .catch((error) => { if (error.status !== 425 || retry >= 2) throw error; return {}; })).token;
    }
    added = (await post(server, '/api/pair/approve', { code, sealed: await sealPair(link.t, raw, code) }, token)).deviceName;
  }
  await saveAccountKey(server, raw);
  return { token, added, addedName: link.name || added, server };
}

// `r`: the recovery phrase's key; the server returns K sealed under it.
export async function recoverAccount(server, r) {
  const { token, accountId, keySealed } = await post(server, '/api/account/recover', { joinSecret: await joinSecretOf(r), ...me() });
  const raw = keySealed && await openRecovery(r, keySealed, accountId);
  if (raw?.length !== 32 || (await accountOf(raw)).accountId !== accountId) throw new Error('This phrase does not open its account.');
  await saveAccountKey(server, raw);
  return token;
}

// The phrase's key R, sealed under K in /devices; null while a computer has yet to make one after a removal.
export async function recoveryKey() {
  const { phraseSealed } = await devices();
  const { key } = (await loadAccountKey(state.SERVER)) || {};
  return phraseSealed && key ? openPhrase(key, phraseSealed) : null;
}

// Signed in: an online computer of this account seals K for the new device.
export async function viaComputer(method, params = {}) {
  const online = cachedOnlineDevices().length ? cachedOnlineDevices() : (await devices(), cachedOnlineDevices());
  if (!online.length) throw new Error('Turn on one of your computers to add a device.');
  return request(online[0], method, params);
}

// A device leaves (`path`: a computer or other Apps): its tokens are revoked, K stays; a hosted account's recovery
// phrase is replaced by one of its computers.
export async function removeDevice(path, body) {
  await post(state.SERVER, path, body, state.KEY);
  return devices();
}
