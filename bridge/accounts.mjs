// `bridge.mjs pair` (docs/v2-accounts-design.md §5): a computer without K joins the account of the App that
// scans its code; one with K shows a code that adds a new App. The QR codes carry the secret K is sealed
// under, so they are printed only to an interactive terminal, never to the service's logs.
import { randomBytes } from 'crypto';
import fs from 'fs';
import qrcode from 'qrcode-terminal';
import { CONFIG_PATH, saveConfig } from './config.mjs';
import { fingerprint, openPair, openRotation, sealPair } from './e2ee-node.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(config, path, body, fetchImpl = fetch) {
  const res = await fetchImpl(`${config.server}${path}`, {
    method: body ? 'POST' : 'GET', body: body && JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}) },
  });
  const reply = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(reply.detail || `HTTP ${res.status}`), { status: res.status });
  return reply;
}

// `web` (the server's reply): where the App is served, which also serves its data socket.
const link = (kind, code, t, web) => `${web}/landing.html#${kind}=${code}&t=${t.toString('base64url')}`;
const sealed = (config, t, code) => sealPair(t, Buffer.from(config.accountKey, 'base64'), code);

function show(print, url) {
  qrcode.generate(url, { small: true }, (qr) => print(qr));
  print(url);
}

// Resolves with the config to save once an App approved this computer; a new code every 10 minutes.
export async function join(config, { print = console.log, sleep = pause, fetchImpl = fetch } = {}) {
  for (;;) {
    const t = randomBytes(16);
    const { code, poll, expiresIn, web } = await call(config, '/api/pair/start', { deviceName: config.deviceName }, fetchImpl);
    print('\nScan with the Baton app on your phone to add this computer:');
    show(print, link('j', code, t, web || config.server));
    for (const end = Date.now() + expiresIn * 1000; Date.now() < end; await sleep(2000)) {
      const reply = await call(config, '/api/pair/wait', { code, poll }, fetchImpl).catch((error) => (error.status === 404 ? null : { pending: true }));
      if (!reply) break;
      if (reply.pending) continue;
      const k = openPair(t, reply.sealed, code);
      // The server names the account's current key (`head`, a fingerprint): K must be that key.
      if (k?.length !== 32 || (reply.head && fingerprint(k) !== reply.head)) throw new Error('the key received is not the account\'s; not joining');
      print(`Joined, approved by ${reply.approvedBy}`);
      return { ...config, apiKey: reply.token, accountKey: k.toString('base64'), accountKeyAt: Date.now(), accounts: true };
    }
  }
}

// A one-use link that adds a new App to this computer's account (`pair`, the App's `pair_invite`).
export async function createInvite(config) {
  const t = randomBytes(16);
  const code = randomBytes(16).toString('base64url');
  const { expiresIn, web } = await call(config, '/api/pair/create', { code, sealed: sealed(config, t, code) });
  return { link: link('c', code, t, web || config.server), expiresIn };
}

// Adds the computer that printed `url` to this computer's account (`pair <link>`, the App's `pair_approve`).
export function approveJoin(config, url) {
  const params = new URLSearchParams(String(url).split('#')[1] || '');
  if (!params.get('j') || !params.get('t')) throw new Error('not a computer\'s join code');
  const t = Buffer.from(params.get('t'), 'base64url');
  return call(config, '/api/pair/approve', { code: params.get('j'), sealed: sealed(config, t, params.get('j')) });
}

// The newest K after rotations made while this computer was away or just now (`account_rotated`), or null.
export async function rotatedKey(config) {
  const { rotations = [] } = await call(config, '/api/bridge/devices');
  let k = Buffer.from(config.accountKey, 'base64');
  // At most one step per entry: a chain that loops back cannot hang this loop.
  for (let step = 0, entry; step < rotations.length && (entry = rotations.find((candidate) => candidate.fp === fingerprint(k))); step++) {
    const next = openRotation(k, entry.sealed, entry.fp);
    if (next?.length !== 32) break;
    k = next;
  }
  return k.toString('base64') === config.accountKey ? null : k;
}

export async function runPair() {
  const target = process.argv[3];
  let config;
  try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch {
    console.error('No Bridge config; run the install command first.');
    return 1;
  }
  if (config.accountKey && target) {
    console.log(`Added ${(await approveJoin(config, target)).deviceName}`);
    return 0;
  }
  if (!process.stdout.isTTY) {
    console.error('Run `node ~/.baton-bridge/bridge.mjs pair` in a terminal: its QR code is shown only there.');
    return 1;
  }
  if (!config.accountKey && config.apiKey) {
    console.error('This computer has no account key yet; open the Baton app once, then try again.');
    return 1;
  }
  if (!config.accountKey) {
    saveConfig(await join(config));
    return 0;
  }
  for (;;) {
    const { link: invite, expiresIn } = await createInvite(config);
    console.log('\nScan with the Baton app on a new phone, or open the link in a browser, to add it (Ctrl-C to stop):');
    show(console.log, invite);
    await pause(expiresIn * 1000);
  }
}
