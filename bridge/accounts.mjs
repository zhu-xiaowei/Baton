// `bridge.mjs pair` (docs/v2-accounts-design.md §5): a computer without K joins the account of the App that
// scans its code; one with K shows a code that adds a new App. The QR codes carry the secret K is sealed
// under, so they are printed only to an interactive terminal, never to the service's logs.
import { randomBytes } from 'crypto';
import fs from 'fs';
import qrcode from 'qrcode-terminal';
import { CONFIG_PATH, saveConfig } from './config.mjs';
import { accountOf, openPair, sealPair } from './e2ee-node.mjs';

const POLL_MS = 2000;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(config, path, body, fetchImpl) {
  const res = await fetchImpl(`${config.server}${path}`, {
    method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}) },
  });
  const reply = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(reply.detail || `HTTP ${res.status}`), { status: res.status });
  return reply;
}

const pairLink = (config, kind, code, t) => `${config.server}/landing.html#${kind}=${code}&t=${t.toString('base64url')}`;

function show(print, link) {
  qrcode.generate(link, { small: true }, (qr) => print(qr));
  print(link);
}

// Resolves with the config to save once an App approved this computer; a new code every 10 minutes.
export async function join(config, { print = console.log, sleep = pause, fetchImpl = fetch } = {}) {
  for (;;) {
    const t = randomBytes(16);
    const { code, poll, expiresIn } = await call(config, '/api/pair/start', { deviceName: config.deviceName }, fetchImpl);
    print('\nScan with the Baton app on your phone to add this computer:');
    show(print, pairLink(config, 'j', code, t));
    for (const end = Date.now() + expiresIn * 1000; Date.now() < end; await sleep(POLL_MS)) {
      let reply;
      try {
        reply = await call(config, '/api/pair/wait', { code, poll }, fetchImpl);
      } catch (error) {
        if (error.status === 404) break;
        continue;
      }
      if (reply.pending) continue;
      const k = openPair(t, reply.sealed, code);
      if (k?.length !== 32 || accountOf(k).accountId !== reply.accountId) {
        throw new Error('the server answered with a key that does not belong to the account; not joining');
      }
      print(`Joined, approved by ${reply.approvedBy}`);
      return { ...config, apiKey: reply.token, accountKey: k.toString('base64'), accountKeyAt: Date.now(), accounts: true };
    }
  }
}

// A one-use link that adds a new App to this computer's account (also the App's `pair_invite` request).
export async function createInvite(config, fetchImpl = fetch) {
  const t = randomBytes(16);
  const code = randomBytes(16).toString('base64url');
  const k = Buffer.from(config.accountKey, 'base64');
  const { expiresIn } = await call(config, '/api/pair/create', { code, sealed: sealPair(t, k, code) }, fetchImpl);
  return { link: pairLink(config, 'c', code, t), expiresIn };
}

// Adds the computer that printed `link` to this computer's account (`pair <link>`, the App's `pair_approve`).
export async function approveJoin(config, link, fetchImpl = fetch) {
  const { kind, code, t } = parseLink(link);
  if (kind !== 'j') throw new Error('not a computer\'s join code');
  const k = Buffer.from(config.accountKey, 'base64');
  return call(config, '/api/pair/approve', { code, sealed: sealPair(t, k, code) }, fetchImpl);
}

export function parseLink(link) {
  const params = new URLSearchParams(String(link).split('#')[1] || '');
  const kind = params.has('j') ? 'j' : params.has('c') ? 'c' : '';
  if (!kind || !params.get('t')) throw new Error('not a Baton pairing link');
  return { kind, code: params.get(kind), t: Buffer.from(params.get('t'), 'base64url') };
}

export async function runPair() {
  if (!process.stdout.isTTY && !process.argv[3]) {
    console.error('Run `node ~/.baton-bridge/bridge.mjs pair` in a terminal: its QR code is shown only there.');
    return 1;
  }
  let config;
  try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch {
    console.error('No Bridge config; run the install command first.');
    return 1;
  }
  const link = process.argv[3];
  if (config.accountKey && link) console.log(`Added ${(await approveJoin(config, link)).deviceName}`);
  else if (config.accountKey) {
    for (;;) {
      const { link: invite, expiresIn } = await createInvite(config);
      console.log('\nScan with the Baton app on a new phone, or open the link in a browser, to add it (Ctrl-C to stop):');
      show(console.log, invite);
      await pause(expiresIn * 1000);
    }
  } else if (!config.apiKey) saveConfig(await join(config));
  else {
    console.error('This computer has no account key yet; open the Baton app once, then try again.');
    return 1;
  }
  return 0;
}
