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

function show(config, print, kind, code, t) {
  const link = `${config.server}/landing.html#${kind}=${code}&t=${t.toString('base64url')}`;
  qrcode.generate(link, { small: true }, (qr) => print(qr));
  print(link);
}

// Resolves with the config to save once an App approved this computer; a new code every 10 minutes.
export async function join(config, { print = console.log, sleep = pause, fetchImpl = fetch } = {}) {
  for (;;) {
    const t = randomBytes(16);
    const { code, poll, expiresIn } = await call(config, '/api/pair/start', { deviceName: config.deviceName }, fetchImpl);
    print('\nScan with the Baton app on your phone to add this computer:');
    show(config, print, 'j', code, t);
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

// Offers K to one new App per code, until Ctrl-C.
export async function showAppCode(config, { print = console.log, sleep = pause, fetchImpl = fetch } = {}) {
  const k = Buffer.from(config.accountKey, 'base64');
  for (;;) {
    const t = randomBytes(16);
    const code = randomBytes(16).toString('base64url');
    const { expiresIn } = await call(config, '/api/pair/create', { code, sealed: sealPair(t, k, code) }, fetchImpl);
    print('\nScan with the Baton app on a new phone to add it (Ctrl-C to stop):');
    show(config, print, 'c', code, t);
    await sleep(expiresIn * 1000);
  }
}

export async function runPair() {
  if (!process.stdout.isTTY) {
    console.error('Run `node ~/.baton-bridge/bridge.mjs pair` in a terminal: its QR code is shown only there.');
    return 1;
  }
  let config;
  try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch {
    console.error('No Bridge config; run the install command first.');
    return 1;
  }
  if (config.accountKey) await showAppCode(config);
  else if (!config.apiKey) saveConfig(await join(config));
  else {
    console.error('This computer has no account key yet; open the Baton app once, then try again.');
    return 1;
  }
  return 0;
}
