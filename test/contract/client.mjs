// Contract-test client for any Baton server deployment, addressed only by URL (BATON_URL, BATON_KEY, BATON_WS;
// BATON_WEB_URL where the web app has its own host).
// With BATON_ORIGIN_SECRET each request poses as CloudFront relaying a random viewer, so rate limits never carry over.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { accountOf, openPair, pairCode, recoveryOf, sealPair } from '../../bridge/e2ee-node.mjs';

export const BASE = process.env.BATON_URL?.replace(/\/$/, '');
export const WEB = process.env.BATON_WEB_URL?.replace(/\/$/, '') || BASE;
export const { BATON_KEY: KEY, BATON_WS: WS, BATON_ORIGIN_SECRET: ORIGIN } = process.env;
export const skip = BASE ? false : 'BATON_URL is unset';
export const randomIp = () => `10.${[...randomBytes(3)].join('.')}`;
export const code = () => randomBytes(16).toString('base64url');
export const GONE = 'This code is used or expired.';
export let headers; // the last response's

export async function api(path, body, { token, ip, status = 200, base = BASE } = {}) {
  const sent = { ...(body && { 'content-type': 'application/json' }), ...(token && { 'x-api-key': token }),
    ...(ORIGIN && { 'x-baton-origin': ORIGIN, 'x-forwarded-for': ip || randomIp() }) };
  const res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: sent, body: body && JSON.stringify(body) });
  const text = await res.text();
  assert.equal(res.status, status, `${path} → ${res.status} ${text.slice(0, 200)}`);
  headers = res.headers;
  return res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
}

export const devices = (token, status) => api('/api/bridge/devices', undefined, { token, status });

export async function newAccount(deviceName = 'ct-app', opts = {}) {
  const k = randomBytes(32), r = randomBytes(32);
  const account = accountOf(k), recovery = recoveryOf(r, k);
  const { token } = await api('/api/account/register', { ...account, ...recovery, deviceName }, opts);
  return { k, r, ...account, joinSecret: recovery.joinSecret, token };
}

export async function startComputer(deviceName) {
  const t = randomBytes(16);
  return { ...(await api('/api/pair/start', { deviceName, code: pairCode(t) })), t };
}

export const approve = (token, k, start, status) =>
  api('/api/pair/approve', { code: start.code, sealed: sealPair(start.t, k, start.code) }, { token, status });

// pair/wait once approved: the token, and K opened the way bridge/accounts.mjs does.
export async function finish(start, status) {
  const reply = await api('/api/pair/wait', { code: start.code, poll: start.poll }, { status });
  return status ? reply : { ...reply, k: openPair(start.t, reply.sealed, start.code) };
}

export async function joinComputer(approverToken, k, name) {
  const start = await startComputer(name);
  await approve(approverToken, k, start);
  return finish(start);
}

export const deleteAccount = (token) => api('/api/account/delete', {}, { token });
