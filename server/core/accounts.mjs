// Accounts, device tokens and pairing (docs/v2-accounts-design.md). The server never sees K: it keeps
// hash(joinSecret), token hashes, and K sealed under a pairing secret that only the QR code carries.
import { tokenHash } from './auth.mjs';
import { HTTPError, compareDigest, length, nowInt, pattern, sha256, tokenUrlsafe, truncate } from './util.mjs';

export const LINK_SECONDS = 900; // pairing codes and Setup's start token (Start URL, QR code, install command)
const MAX_BRIDGES = 10;
const GONE = 'This code is used or expired.';
const COLLECT_SECONDS = 60; // an approved computer code stays collectable this long past its expiry (RFC 8628 polling)
const REGISTER_MARGIN = 30; // a new account needs this long left on its computer's code, for the approval that follows
const required = { required: true };

export const Body = [
  ['accountId', pattern('^([0-9a-f]{16})?$')],
  ['fp', pattern('^([0-9a-f]{16})?$')],
  ['joinSecret', pattern('^([\\w-]{22,64})?$')],
  ['code', pattern('^([\\w-]{22,64})?$')],
  ['poll', pattern('^([\\w-]{22,64})?$')],
  ['sealed', pattern('^([\\w+/=-]{40,200})?$')],
  ['deviceName', {}],
  ['install', pattern('^[\\w-]{0,64}$')], // an App's own random id: joining again replaces its token
  ['id', pattern('^([0-9a-f]{12})?$')],
  ['ids', pattern('^([0-9a-f]{12}(,[0-9a-f]{12}){0,199})?$')], // revoke: several Apps at once
  // The recovery phrase is R, not K: K sealed under R (recover) and R sealed under K (members show the phrase).
  ['keySealed', pattern('^([\\w+/=-]{40,200})?$')],
  ['phraseSealed', pattern('^([\\w+/=-]{40,200})?$')],
  ['retry', pattern('^[0-9]?$')], // register: attempts so far at placing the account (Cloudflare)
  ['nameTag', pattern('^([0-9a-f]{32})?$')], // a hosted computer's display-name tag (bridge/e2ee-node.mjs)
];

// A Durable Object region near where an endpoint enters Cloudflare (the Worker's x-baton-edge); through the relay that is Tokyo.
export function locationHint({ relay, continent, lon } = {}) {
  if (relay) return 'apac';
  if (continent === 'AS') return Number.isFinite(lon) && lon < 60 ? 'me' : 'apac'; // Cloudflare's AS includes the Middle East
  if (continent === 'NA') return lon < -100 ? 'wnam' : 'enam';
  if (continent === 'EU') return lon > 20 ? 'eeur' : 'weur';
  return { OC: 'oc', SA: 'sam', AF: 'afr' }[continent];
}
const JAPAN = new Set(['NRT', 'KIX']);

// A direct caller's address, signed (`ip|country|asn|expiry.signature`), for its requests through the relay (docs/v2-cn-relay.md).
const IP_TOKEN_SECONDS = 7 * 86400;
async function ipSignature(secret, payload) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`ip-token|${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))).slice(0, 16);
  return btoa(String.fromCharCode(...mac)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export async function issueIpToken(secret, { ip, country = '', asn = '' }) {
  const payload = [ip, country, asn, nowInt() + IP_TOKEN_SECONDS].join('|');
  return `${payload}.${await ipSignature(secret, payload)}`;
}
export async function readIpToken(secret, token) {
  const at = String(token ?? '').lastIndexOf('.');
  if (!secret || at < 1 || !compareDigest(token.slice(at + 1), await ipSignature(secret, token.slice(0, at)))) return null;
  const [ip, country, asn, expiry] = token.slice(0, at).split('|');
  return Number(expiry) > nowInt() ? { ip, country, asn } : null;
}

export function need(body, ...fields) {
  const missing = fields.filter((name) => !body[name]);
  if (missing.length) throw new HTTPError(422, `Missing: ${missing.join(', ')}`);
}

// sockets: { query(account, role, device?), post(endpoint, id, data), deleteConnection(endpoint, id), handleDisconnect(id) }
export function createAccounts({ env, table, auth, devices, sockets, log, place }) {
  const open = () => env.OPEN_REGISTRATION === 'true';
  // Cloudflare: the Web App (WEB_URL) is on another origin than the API, which pairing links then name.
  const api = () => (env.API_URL ? { api: env.API_URL } : {});

  async function conditional(write) {
    try {
      return (await write()) || true;
    } catch (error) {
      if (error.code !== 'ConditionalCheckFailedException') throw error;
      return false;
    }
  }

  // API Gateway appends the address it saw; behind CloudFront that is CloudFront, which appended the viewer
  // before it. Only CloudFront knows the origin secret, so a direct caller cannot pose as it.
  function ip({ headers, clientIp }) {
    const hops = (headers.get('x-forwarded-for') ?? '').split(',').map((hop) => hop.trim()).filter(Boolean);
    if (!hops.length) return clientIp;
    const secret = env.ORIGIN_SECRET ?? '';
    const viaCdn = !!secret && compareDigest(headers.get('x-baton-origin') ?? '', secret);
    return viaCdn && hops.length > 1 ? hops.at(-2) : hops.at(-1);
  }

  // The mainland-China relay (docs/v2-cn-relay.md) hides its users' addresses.
  const relayed = (request) => (env.RELAY_IPS ?? '').split(',').includes(ip(request));
  // Through the relay a signed address (x-baton-ip) counts, at `own` times the limit; without one, the relay's.
  async function perIp(name, request, limit, own = 1) {
    const signed = relayed(request) && await readIpToken(env.IP_TOKEN_KEY, request.headers.get('x-baton-ip'));
    return rate(`${name}#${signed ? signed.ip : ip(request)}`, signed ? limit * own : limit);
  }
  // /api/version signs direct callers' addresses, only where a relay is configured.
  async function ipToken(request) {
    const edge = edgeOf(request);
    const secret = env.API_ENTRIES && !edge.relay && env.IP_TOKEN_KEY;
    return secret ? issueIpToken(secret, { ip: ip(request), country: edge.country, asn: edge.asn }) : undefined;
  }
  function edgeOf(request) {
    let edge = {};
    try { edge = JSON.parse(request.headers.get('x-baton-edge') || '{}'); } catch {}
    return { ...edge, relay: relayed(request) };
  }

  async function rate(scope, limit) {
    const start = Math.floor(nowInt() / 3600) * 3600;
    if (await conditional(() => table.updateItem({
      Key: { pk: `RATE#${scope}`, sk: String(start) }, UpdateExpression: 'ADD n :one SET #ttl = :ttl',
      ConditionExpression: 'attribute_not_exists(n) OR n < :limit', ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':one': 1, ':limit': limit, ':ttl': start + 7200 } })) === false) {
      throw new HTTPError(429, 'Too many requests, try again later.');
    }
  }

  // Accounts paired before `hosted` existed are known by their joinSecretHash.
  const isHosted = (row) => !!(row.hosted || row.joinSecretHash);
  const meta = async (account) => (await table.getItem({ Key: { pk: `ACCOUNT#${account}`, sk: 'META' }, ConsistentRead: true })).Item || {};
  const tokenRows = async (account) => (await table.query({ KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :sk)',
    ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' }, ExpressionAttributeValues: { ':pk': `ACCOUNT#${account}`, ':sk': 'TOKEN#' } })).Items;
  const tokenKeys = (account, digest) => [{ pk: `TOKEN#${digest}`, sk: '-' }, { pk: `ACCOUNT#${account}`, sk: `TOKEN#${digest}` }];

  async function issue(account, kind, name, install = '') {
    const token = `bt_${account}_${tokenUrlsafe(32)}`; // the account routes the token (Cloudflare)
    name = truncate(name, 64);
    install = install && await sha256(install);
    if (install) await drop(account, (await tokenRows(account)).filter((row) => row.install === install).map((row) => row.sk.slice(6)));
    const [index, listed] = tokenKeys(account, await tokenHash(token));
    // Listed first: a token whose index write failed is visible and removable, never a hidden credential.
    await table.putItem({ Item: { ...listed, kind, deviceName: name, install, createdAt: nowInt() } });
    // Cloudflare resolves tokens from the listed row (the token names its account): no index.
    if (!env.TOKENS_BY_ACCOUNT) await table.putItem({ Item: { ...index, kind, deviceName: name, accountId: account } });
    return token;
  }

  const listTokens = async (account) => (await tokenRows(account)).map((row) => ({ id: row.sk.slice(6, 18),
    deviceName: row.deviceName ?? '', kind: row.kind, lastSeen: Math.trunc(row.lastSeen ?? row.createdAt ?? 0) }));

  const pairKey = async (code) => ({ pk: `PAIR#${await sha256(code)}`, sk: '-' });

  // Deleted on use: a code works once. One made or approved by a device that has since left is void.
  async function take(code, condition, values, grace = 0) {
    const Key = await pairKey(code);
    const old = await conditional(() => table.deleteItem({ Key, ReturnValues: 'ALL_OLD',
      ConditionExpression: `attribute_exists(pk) AND #ttl > :now AND ${condition}`, ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':now': nowInt() - grace, ...values } }));
    const by = old && old.Attributes.by;
    const byKey = by && tokenKeys(old.Attributes.accountId, by)[env.TOKENS_BY_ACCOUNT ? 1 : 0];
    if (!old || (by && !(await table.getItem({ Key: byKey })).Item)) throw new HTTPError(404, GONE);
    return old.Attributes;
  }

  // The self-host account (API key) has no joinSecret; tokens it pairs still need the row (auth.resolve).
  async function ensureMeta(caller) {
    if (caller.kind === 'key') {
      await conditional(() => table.putItem({ Item: { pk: `ACCOUNT#${caller.accountId}`, sk: 'META', createdAt: nowInt() },
        ConditionExpression: 'attribute_not_exists(pk)' }));
    }
  }

  const joined = async (row, kind, name, install = '', extra = {}) => ({ token: await issue(row.accountId, kind, name, install),
    accountId: row.accountId, sealed: row.sealed, head: (await meta(row.accountId)).head ?? '', ...extra });

  // A name is the computer's identity: a second one with it would take the first one's place. A hosted computer's
  // display name is sealed: its tag stands in for it.
  async function roomFor(account, name, tag = '') {
    const computers = (await tokenRows(account)).filter((row) => row.kind === 'bridge').map((row) => row.deviceName);
    if (open() && computers.length >= MAX_BRIDGES) throw new HTTPError(409, `This account already has ${MAX_BRIDGES} computers.`);
    if (computers.includes(name)) throw new HTTPError(409, `A computer named ${name} is already in this account; reinstall with another name.`);
    if (tag && (await devices.list(account)).some((item) => item.nameTag === tag)) {
      throw new HTTPError(409, 'A computer with this name is already in this account; reinstall with another name.');
    }
  }

  async function selfHosted(account) {
    const pinned = env.ACCOUNT_ID;
    const own = await auth.accountId(await auth.currentKey()); // KeyUnavailable propagates: a 503, never a guess
    return account === pinned || account === own;
  }

  async function register({ body, ...request }) {
    need(body, 'accountId', 'joinSecret', 'fp', 'deviceName', 'keySealed', 'phraseSealed');
    if (!open()) throw new HTTPError(404, 'Registration is closed on this server.');
    await perIp('register', request, 5, 3); // through the relay a sign-in may take 3 (placement retries)
    // The computer's code it comes with must stay open until the approval: no empty account is left behind.
    const pair = body.code && (await table.getItem({ Key: await pairKey(body.code) })).Item;
    if (body.code && !(pair?.kind === 'bridge' && !('accountId' in pair) && pair.ttl > nowInt() + REGISTER_MARGIN)) throw new HTTPError(404, GONE);
    if (place) await placeAccount(body, request, pair); // before anything reads the account: its first access places it
    if (await selfHosted(body.accountId) || (await devices.list(body.accountId)).length) throw new HTTPError(409, 'Account exists.');
    if (await conditional(async () => table.putItem({ Item: { pk: `ACCOUNT#${body.accountId}`, sk: 'META', hosted: true,
      joinSecretHash: await sha256(body.joinSecret), keySealed: body.keySealed, phraseSealed: body.phraseSealed, head: body.fp, createdAt: nowInt() },
    ConditionExpression: 'attribute_not_exists(pk)' })) === false) throw new HTTPError(409, 'Account exists.');
    // Recovery finds the account from joinSecret (derived from R, which changes when a device leaves).
    await table.putItem({ Item: { pk: `JOIN#${await sha256(body.joinSecret)}`, sk: '-', accountId: body.accountId } });
    return { token: await issue(body.accountId, 'app', body.deviceName, body.install) };
  }

  // The account's object goes near its first computer (the pairing code's), else this App. Through the relay it must be in
  // Japan: elsewhere the App retries with a new key (a new account id), up to twice.
  async function placeAccount(body, request, pair) {
    const edge = pair?.edge || edgeOf(request);
    const colo = await place(body.accountId, locationHint(edge)).catch(() => ''); // unknown: kept
    if (edge.relay && colo && !JAPAN.has(colo) && Number(body.retry || 0) < 2) throw new HTTPError(425, 'Placing the account; retry with a new key.');
  }

  async function recover({ body, ...request }) {
    need(body, 'joinSecret', 'deviceName');
    await perIp('recover', request, 5);
    const digest = await sha256(body.joinSecret);
    const account = (await table.getItem({ Key: { pk: `JOIN#${digest}`, sk: '-' }, ConsistentRead: true })).Item?.accountId;
    const current = account ? await meta(account) : {};
    if (!account || !compareDigest(current.joinSecretHash ?? '', digest)) {
      throw new HTTPError(403, 'Recovery phrase does not match an account.');
    }
    await rate(`recover#${account}`, 5);
    return { token: await issue(account, 'app', body.deviceName, body.install), accountId: account, keySealed: current.keySealed };
  }

  // A new R from a computer (it holds K raw; an App's K is not extractable) after a device left; the first one wins.
  async function setRecovery({ body, auth: caller }) {
    need(body, 'joinSecret', 'keySealed', 'phraseSealed');
    const current = await meta(caller.accountId);
    if (caller.kind !== 'bridge' || !isHosted(current)) throw new HTTPError(403, 'Only a computer of a paired account renews recovery.');
    const join = await sha256(body.joinSecret);
    const old = current.joinSecretHash; // an account from before R: its phrase was K
    if (await conditional(() => table.updateItem({ Key: { pk: `ACCOUNT#${caller.accountId}`, sk: 'META' },
      UpdateExpression: 'SET hosted = :yes, joinSecretHash = :join, keySealed = :key, phraseSealed = :phrase', ConditionExpression: 'attribute_not_exists(phraseSealed)',
      ExpressionAttributeValues: { ':yes': true, ':join': join, ':key': body.keySealed, ':phrase': body.phraseSealed } })) === false) return { ok: false };
    if (old) await table.deleteItem({ Key: { pk: `JOIN#${old}`, sk: '-' } });
    await table.putItem({ Item: { pk: `JOIN#${join}`, sk: '-', accountId: caller.accountId } });
    return { ok: true };
  }

  // The client picks the code (a hash of its link's secret; format checked by Body); older Bridges let pair/start pick one.
  async function newCode(code, item) {
    if (await conditional(async () => table.putItem({ Item: { ...await pairKey(code), ...item, ttl: nowInt() + LINK_SECONDS },
      ConditionExpression: 'attribute_not_exists(pk)' })) === false) throw new HTTPError(409, 'Code in use.');
  }

  async function pairCreate({ body, auth: caller }) {
    need(body, 'code', 'sealed');
    await ensureMeta(caller);
    await newCode(body.code, { kind: 'app', accountId: caller.accountId, by: caller.tokenHash ?? '', sealed: body.sealed });
    return { expiresIn: LINK_SECONDS, web: env.WEB_URL ?? '', ...api() };
  }

  async function pairClaim({ body }) {
    need(body, 'code', 'deviceName');
    return joined(await take(body.code, 'kind = :app', { ':app': 'app' }), 'app', body.deviceName, body.install);
  }

  async function pairStart({ body, ...request }) {
    need(body, 'deviceName');
    if (length(body.deviceName) > 64) { // a computer connects by this name: it must fit its token row as it is
      throw new HTTPError(422, 'Device name is too long (64 characters at most).');
    }
    await perIp('start', request, 10);
    const [code, poll] = [body.code || tokenUrlsafe(16), tokenUrlsafe(16)];
    await newCode(code, { kind: 'bridge', pollHash: await sha256(poll), deviceName: body.deviceName, edge: edgeOf(request) });
    return { code, poll, expiresIn: LINK_SECONDS, web: env.WEB_URL ?? '', ...api() };
  }

  async function pairApprove({ body, auth: caller }) {
    need(body, 'code', 'sealed');
    await ensureMeta(caller);
    const Key = await pairKey(body.code);
    await roomFor(caller.accountId, (await table.getItem({ Key, ConsistentRead: true })).Item?.deviceName, body.nameTag);
    const row = await conditional(() => table.updateItem({ Key, ReturnValues: 'ALL_NEW',
      UpdateExpression: 'SET accountId = :account, sealed = :sealed, approvedBy = :by, #by = :token, nameTag = :tag',
      ConditionExpression: 'attribute_exists(pk) AND kind = :bridge AND #ttl > :now AND attribute_not_exists(accountId)',
      ExpressionAttributeNames: { '#ttl': 'ttl', '#by': 'by' }, ExpressionAttributeValues: { ':account': caller.accountId,
        ':sealed': body.sealed, ':bridge': 'bridge', ':by': caller.deviceName || 'Baton', ':token': caller.tokenHash ?? '', ':tag': body.nameTag ?? '', ':now': nowInt() } }));
    if (!row) throw new HTTPError(404, GONE);
    return { deviceName: row.Attributes.deviceName };
  }

  async function pairWait({ body }) {
    // The computer's token is issued only here, so no row ever holds one.
    need(body, 'code', 'poll');
    let row = (await table.getItem({ Key: await pairKey(body.code), ConsistentRead: true })).Item || {};
    const approved = 'accountId' in row; // an approval made in time is collected even just after the code expired
    if (row.kind !== 'bridge' || Math.trunc(row.ttl ?? 0) + (approved ? COLLECT_SECONDS : 0) <= Date.now() / 1000
      || !compareDigest(row.pollHash ?? '', await sha256(body.poll))) throw new HTTPError(404, GONE);
    if (!approved) return { pending: true };
    row = await take(body.code, 'pollHash = :poll AND attribute_exists(accountId)', { ':poll': await sha256(body.poll) }, COLLECT_SECONDS);
    await roomFor(row.accountId, row.deviceName, row.nameTag); // again: other codes may have been approved meanwhile
    return joined(row, 'bridge', row.deviceName, '', { approvedBy: row.approvedBy });
  }

  // ---- Removal, deletion ----

  async function close(account, digest = null, notice = null) {
    for (const role of ['app', 'bridge', 'app_data', 'bridge_data', 'notify']) { // notify: Cloudflare's Android alert socket
      const endpoint = env[role.endsWith('_data') ? 'TERMINAL_DIRECT_ENDPOINT' : 'WS_API_ENDPOINT'] ?? '';
      for (const item of endpoint ? await sockets.query(account, role) : []) {
        // The role index projects only deviceName: read the connection itself for its token.
        if (digest && (item.tokenHash ?? (await sockets.get(item.connectionId))?.tokenHash) !== digest) continue;
        try {
          if (notice && role === 'bridge') await sockets.post(endpoint, item.connectionId, { action: notice });
          await sockets.deleteConnection(endpoint, item.connectionId);
        } catch (error) {
          log(`socket not closed: ${error.message}`);
        }
        await sockets.handleDisconnect(item.connectionId);
      }
    }
  }

  // A device leaves: its tokens and sockets go (a Bridge told `notice` first); K stays. A hosted account's recovery
  // (R, which the leaving device could have read) is voided first, so a removal that fails midway is retried with the
  // tokens still there; the remaining computers then make a new R.
  async function remove(caller, digests, notice = null) {
    if (caller.kind === 'bridge') throw new HTTPError(403, 'Remove devices from an App.');
    const account = caller.accountId;
    if (!digests.length) return;
    const current = await meta(account);
    const hosted = isHosted(current);
    if (hosted) {
      // Unconditional: an R set meanwhile is voided too (computers make another), and a JOIN# row left behind
      // without its META hash recovers nothing (recover compares both).
      await table.updateItem({ Key: { pk: `ACCOUNT#${account}`, sk: 'META' }, UpdateExpression: 'SET hosted = :yes REMOVE joinSecretHash, keySealed, phraseSealed',
        ExpressionAttributeValues: { ':yes': true } });
      if (current.joinSecretHash) await table.deleteItem({ Key: { pk: `JOIN#${current.joinSecretHash}`, sk: '-' } });
    }
    await drop(account, digests, notice);
    for (const item of hosted ? await sockets.query(account, 'bridge') : []) {
      try {
        await sockets.post(env.WS_API_ENDPOINT ?? '', item.connectionId, { action: 'recovery_reset' });
      } catch {}
    }
  }

  // Tokens, the push registrations made with them, their sockets.
  async function drop(account, digests, notice = null) {
    if (!digests.length) return;
    const pushes = (await table.query({ KeyConditionExpression: '#pk = :pk', ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':pk': `PUSH_DEVICE#${account}` } })).Items;
    for (const digest of digests) {
      for (const key of [...tokenKeys(account, digest), ...pushes.filter((push) => push.tokenHash === digest)]) {
        await table.deleteItem({ Key: { pk: key.pk, sk: key.sk } });
      }
      await close(account, digest, notice);
    }
  }

  const computerTokens = async (account, name) => (await tokenRows(account))
    .filter((row) => row.kind === 'bridge' && row.deviceName === name).map((row) => row.sk.slice(6));

  async function revoke({ body, auth: caller }) {
    // No id: log out. An id (or several, `ids`): remove other Apps of the account (a lost phone).
    const ids = body.ids ? body.ids.split(',') : body.id ? [body.id] : [];
    if (!ids.length) {
      await drop(caller.accountId, caller.tokenHash ? [caller.tokenHash] : []);
      // A computer that left (`leave`) is no longer listed.
      if (caller.kind === 'bridge') await devices.delete(caller.accountId, caller.deviceName);
      return { ok: true };
    }
    const rows = await tokenRows(caller.accountId);
    // Ids already gone (removed elsewhere meanwhile) are skipped; none left, or this App itself, is a 404.
    const digests = ids.map((id) => rows.find((row) => row.sk.slice(6, 18) === id && row.kind === 'app')?.sk.slice(6)).filter(Boolean);
    if (!digests.length || digests.includes(caller.tokenHash)) throw new HTTPError(404, 'No such App in this account.');
    await remove(caller, digests);
    return { ok: true };
  }

  async function deleteAccount({ auth: caller }) {
    const account = caller.accountId;
    if (caller.kind !== 'app' || !isHosted(await meta(account))) {
      throw new HTTPError(403, 'Only an App of an account made by pairing can delete it.');
    }
    await close(account, null, 'account_deleted');
    for (const item of await devices.list(account)) await devices.delete(account, item.deviceName);
    for (const pk of [`ACCOUNT#${account}`, `PUSH_DEVICE#${account}`, `NOTIFICATIONS#${account}`]) {
      for (;;) {
        const rows = (await table.query({ KeyConditionExpression: '#pk = :pk', ExpressionAttributeNames: { '#pk': 'pk' },
          ExpressionAttributeValues: { ':pk': pk } })).Items;
        if (!rows.length) break;
        for (const row of rows) {
          if (row.sk === 'META' && row.joinSecretHash) await table.deleteItem({ Key: { pk: `JOIN#${row.joinSecretHash}`, sk: '-' } });
          if (row.sk.startsWith('TOKEN#')) await table.deleteItem({ Key: { pk: row.sk, sk: '-' } });
          await table.deleteItem({ Key: { pk: row.pk, sk: row.sk } });
        }
      }
    }
    return { ok: true };
  }

  const routes = [
    ['/api/account/register', register], ['/api/account/recover', recover], ['/api/pair/create', pairCreate],
    ['/api/pair/claim', pairClaim], ['/api/pair/start', pairStart], ['/api/pair/approve', pairApprove],
    ['/api/pair/wait', pairWait], ['/api/tokens/revoke', revoke], ['/api/account/recovery', setRecovery],
  ].map(([path, handler]) => ({ method: 'POST', path, body: Body, handler }));
  routes.push({ method: 'POST', path: '/api/account/delete', handler: deleteAccount });
  return { routes, remove, computerTokens, listTokens, meta, isHosted, ipToken };
}
