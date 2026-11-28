// `bridge.mjs pair` (docs/v2-accounts-design.md §5): a computer without K joins the account of the App that
// scans its code; one with K shows a code that adds a new App. The QR codes carry the secret K is sealed
// under, so they are printed only to an interactive terminal, never to the service's logs.
import { randomBytes } from 'crypto';
import fs from 'fs';
import { createInterface } from 'readline/promises';
import qrcode from 'qrcode-terminal';
import { BRIDGE_HOME, CONFIG_PATH, bridgeCommand, saveConfig } from './config.mjs';
import { deviceNameTag, fingerprint, openPair, pairCode, recoveryOf, sealPair } from './e2ee-node.mjs';
import { pickEntry, vouched } from './entry.mjs';
import { runningBridgePid } from './instance-lock.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(config, path, body, fetchImpl = fetch) {
  try { return await request(config.entry || config.server, config, path, body, fetchImpl); } catch (error) {
    // The relay's one shared address may have used up a per-address limit: this computer's own address then.
    if (error.status !== 429 || !config.entry || config.entry === config.server) throw error;
    return request(config.server, config, path, body, fetchImpl);
  }
}

async function request(base, config, path, body, fetchImpl) {
  const res = await fetchImpl(`${base}${path}`, {
    method: body ? 'POST' : 'GET', body: body && JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}),
      ...(base !== config.server && vouched.token ? { 'x-baton-ip': vouched.token } : {}) },
  });
  const reply = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(reply.detail || `HTTP ${res.status}`), { status: res.status });
  return reply;
}

// One secret per link (`p`): the server sees only pairCode(p), and K is sealed under p. `web` (the server's reply)
// is where the App is served; that page knows its API server, so the link needs only the fragment.
// A computer's link also names it (`n`): the fragment never reaches the server, which knows the computer by a random ID.
const link = (kind, p, web, server, name = '') => `${web || server}/#${kind}=${p.toString('base64url')}${name ? `&n=${encodeURIComponent(name)}` : ''}`;
const sealed = (config, t, code) => sealPair(t, Buffer.from(config.accountKey, 'base64'), code);

function show(print, url) {
  qrcode.generate(url, { small: true }, (qr) => print(qr));
  print(`Start URL: ${url}`);
}

// Resolves with the config to save once an App approved this computer; a new code every 15 minutes.
export async function join(config, { print = console.log, sleep = pause, fetchImpl = fetch } = {}) {
  // The account is placed near this computer's entry. The host name stays the display name, sealed (ws.mjs).
  config = { ...config, entry: await pickEntry(config.server, fetchImpl),
    deviceDisplayName: [...(config.deviceDisplayName || config.deviceName || '')].slice(0, 64).join(''), deviceName: `pc-${randomBytes(4).toString('hex')}` };
  for (;;) {
    const t = randomBytes(16);
    const { code, poll, expiresIn, web } = await call(config, '/api/pair/start', { deviceName: config.deviceName, code: pairCode(t) }, fetchImpl);
    print('\nScan with the Baton app on your phone to add this computer:');
    show(print, link('j', t, web, config.server, config.deviceDisplayName));
    // Polled until the server calls the code expired (RFC 8628), not by this clock: an approval made at the end is collected.
    for (const end = Date.now() + (expiresIn + 120) * 1000; Date.now() < end; await sleep(2000)) {
      const reply = await call(config, '/api/pair/wait', { code, poll }, fetchImpl).catch((error) => (error.status === 404 ? null : { pending: true }));
      if (!reply) break;
      if (reply.pending) continue;
      const k = openPair(t, reply.sealed, code);
      // The server names the account's current key (`head`, a fingerprint): K must be that key.
      if (k?.length !== 32 || (reply.head && fingerprint(k) !== reply.head)) throw new Error('the key received is not the account\'s; not joining');
      // An App names itself; a computer that approved for one is known by its random ID only.
      print(/^pc-[0-9a-f]{8}$/.test(reply.approvedBy ?? '') ? 'Joined' : `Joined, approved by ${reply.approvedBy}`);
      return { ...config, apiKey: reply.token, accountKey: k.toString('base64'), accountKeyAt: Date.now(), accounts: true };
    }
  }
}

// A one-use link that adds a new App to this computer's account (`pair`, the App's `pair_invite`).
export async function createInvite(config) {
  const t = randomBytes(16);
  const code = pairCode(t);
  const { expiresIn, web } = await call(config, '/api/pair/create', { code, sealed: sealed(config, t, code) });
  return { link: link('c', t, web, config.server), expiresIn };
}

// Adds the computer that printed `url` to this computer's account (`pair <link>`, the App's `pair_approve`).
export function approveJoin(config, url) {
  const params = new URLSearchParams(String(url).split('#')[1] || '');
  if (!params.get('j')) throw new Error('not a computer\'s join code');
  // Older links: `j` is the code itself and `t` the secret.
  const t = Buffer.from(params.get('t') || params.get('j'), 'base64url');
  const code = params.get('t') ? params.get('j') : pairCode(t);
  const name = params.get('n') || '';
  const nameTag = name ? deviceNameTag(Buffer.from(config.accountKey, 'base64'), name) : '';
  return call(config, '/api/pair/approve', { code, sealed: sealed(config, t, code), nameTag })
    .then((reply) => ({ ...reply, displayName: name || reply.deviceName }));
}

// A device left (`recovery_reset`) while this computer was away or just now: a new recovery key R, which the first
// computer to send it sets (the server keeps the first). Returns whether this one did.
export async function renewRecovery(config) {
  const { hosted, phraseSealed } = await call(config, '/api/bridge/devices');
  if (!hosted || phraseSealed) return false;
  return (await call(config, '/api/account/recovery', recoveryOf(randomBytes(32), Buffer.from(config.accountKey, 'base64')))).ok;
}

// `leave`: joins another account with the same server and device fields. config.json is written, and the
// old one backed up, only once the join succeeded; an abort or a failure leaves the old account in place.
export async function leave(config, options) {
  const credentials = ['apiKey', 'accountKey', 'accountKeyAt', 'accounts'];
  const next = await join(Object.fromEntries(Object.entries(config).filter(([k]) => !credentials.includes(k))), options);
  fs.writeFileSync(`${CONFIG_PATH}.bak-${Date.now()}`, JSON.stringify(config, null, 2), { mode: 0o600 });
  saveConfig(next);
  // Only then the old account forgets this computer (the running Bridge restarts into the new one, ws.mjs); if this
  // fails it stays listed there, offline, until removed in the App.
  await call(config, '/api/tokens/revoke', {}, options?.fetchImpl).catch((error) => console.error(`Not removed from the old account: ${error.message}`));
  return next;
}

export async function runPair() {
  const leaving = process.argv[2] === 'leave';
  const target = leaving ? undefined : process.argv[3];
  let config;
  try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch {
    console.error('No Bridge config; run the install command first.');
    return 1;
  }
  if (config.accountKey && target) {
    console.log(`Added ${(await approveJoin(config, target)).displayName}`);
    return 0;
  }
  if (!process.stdout.isTTY) {
    console.error(`Run \`${bridgeCommand(leaving ? 'leave' : 'pair')}\` in a terminal: its QR code is shown only there.`);
    return 1;
  }
  if (leaving && config.apiKey) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const asking = new AbortController();
    prompt.on('SIGINT', () => asking.abort());
    const answer = await prompt.question('Move this computer out of its current account? [y/N] ', asking).catch(() => '');
    prompt.close();
    if (!/^y(es)?$/i.test(answer.trim())) return 0;
    await leave(config);
    // Like after an update, the service manager restarts a Bridge that exits non-zero: SIGHUP makes it do so
    // (Windows has no SIGHUP; SIGTERM there terminates it with code 1, which bridge-launcher.mjs restarts).
    const pid = await runningBridgePid(BRIDGE_HOME).catch(() => 0);
    if (pid) process.kill(pid, process.platform === 'win32' ? 'SIGTERM' : 'SIGHUP');
    console.log(pid ? 'The Bridge is restarting in the new account.' : 'The Bridge uses the new account when it starts.');
    return 0;
  }
  if (!config.accountKey && config.apiKey) {
    console.error('This computer has no account key yet; open the Baton app once, then try again.');
    return 1;
  }
  if (!config.accountKey) {
    saveConfig(await join(config));
    return 0;
  }
  const { link: invite, expiresIn } = await createInvite(config);
  console.log(`\nScan with the Baton app on a new phone, or open the link in a browser, to add it (valid ${Math.round(expiresIn / 60)} minutes):`);
  show(console.log, invite);
  console.log(`To move this computer to another account, run: ${bridgeCommand('leave')}`);
  return 0;
}
