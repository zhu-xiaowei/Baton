// Accounts, device tokens and pairing (docs/v2-accounts-design.md). The server never sees K: it keeps
// hash(joinSecret), token hashes, and K sealed under a pairing secret that only the QR code carries.
import { tokenHash } from './auth.mjs';
import { HTTPError, compareDigest, length, nowInt, pattern, sha256, tokenUrlsafe, truncate } from './util.mjs';

const PAIR_SECONDS = 600;
const MAX_BRIDGES = 10;
const MAX_ROTATIONS = 8;
const GONE = 'This code is used or expired.';
const required = { required: true };

export const Rotation = [
  ['joinSecret', pattern('^[\\w-]{22,64}$', required)],
  ['fp', pattern('^[0-9a-f]{16}$', required)], // the K being replaced: must be the account's head
  ['next', pattern('^[0-9a-f]{16}$', required)], // K'
  ['sealed', pattern('^[\\w+/=-]{40,200}$', required)], // K' sealed under K
];

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
  ['rotation', { model: Rotation, nullable: true, default: null }],
  ['retry', pattern('^[0-9]?$')], // register: attempts so far at placing the account (Cloudflare)
];

// A Durable Object region near where an endpoint enters Cloudflare (the Worker's x-baton-edge); through the relay that is Tokyo.
export function locationHint({ relay, continent, lon } = {}) {
  if (relay || continent === 'AS') return 'apac';
  if (continent === 'NA') return lon < -100 ? 'wnam' : 'enam';
  if (continent === 'EU') return lon > 20 ? 'eeur' : 'weur';
  return { OC: 'oc', SA: 'sam', AF: 'afr' }[continent];
}
const JAPAN = new Set(['NRT', 'KIX']);

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

  // The mainland-China relay (docs/v2-cn-relay.md) hides its users' addresses: its own gets a larger allowance.
  const relayed = (request) => (env.RELAY_IPS ?? '').split(',').includes(ip(request));
  const perIp = (name, request, limit) => rate(`${name}#${ip(request)}`, relayed(request) ? limit * 100 : limit);
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
    await table.putItem({ Item: { ...index, kind, deviceName: name, accountId: account } });
    return token;
  }

  const listTokens = async (account) => (await tokenRows(account)).map((row) => ({ id: row.sk.slice(6, 18),
    deviceName: row.deviceName ?? '', kind: row.kind, lastSeen: Math.trunc(row.lastSeen ?? row.createdAt ?? 0) }));

  const pairKey = async (code) => ({ pk: `PAIR#${await sha256(code)}`, sk: '-' });

  // Deleted on use: a code works once. One made or approved by a device that has since left is void.
  async function take(code, condition, values) {
    const Key = await pairKey(code);
    const old = await conditional(() => table.deleteItem({ Key, ReturnValues: 'ALL_OLD',
      ConditionExpression: `attribute_exists(pk) AND #ttl > :now AND ${condition}`, ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':now': nowInt(), ...values } }));
    const by = old && old.Attributes.by;
    if (!old || (by && !(await table.getItem({ Key: { pk: `TOKEN#${by}`, sk: '-' } })).Item)) throw new HTTPError(404, GONE);
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

  // A name is the computer's identity: a second one with it would take the first one's place.
  async function roomFor(account, name) {
    const computers = (await tokenRows(account)).filter((row) => row.kind === 'bridge').map((row) => row.deviceName);
    if (open() && computers.length >= MAX_BRIDGES) throw new HTTPError(409, `This account already has ${MAX_BRIDGES} computers.`);
    if (computers.includes(name)) throw new HTTPError(409, `A computer named ${name} is already in this account; reinstall with another name.`);
  }

  async function selfHosted(account) {
    const pinned = env.ACCOUNT_ID;
    const own = await auth.accountId(await auth.currentKey()); // KeyUnavailable propagates: a 503, never a guess
    return account === pinned || account === own;
  }

  async function register({ body, ...request }) {
    need(body, 'accountId', 'joinSecret', 'fp', 'deviceName');
    if (!open()) throw new HTTPError(404, 'Registration is closed on this server.');
    await perIp('register', request, 5);
    if (place) await placeAccount(body, request); // before anything reads the account: its first access places it
    if (await selfHosted(body.accountId) || (await devices.list(body.accountId)).length) throw new HTTPError(409, 'Account exists.');
    if (await conditional(async () => table.putItem({ Item: { pk: `ACCOUNT#${body.accountId}`, sk: 'META',
      joinSecretHash: await sha256(body.joinSecret), head: body.fp, createdAt: nowInt() },
    ConditionExpression: 'attribute_not_exists(pk)' })) === false) throw new HTTPError(409, 'Account exists.');
    // accountId is fixed at registration while K (and joinSecret) rotate: recovery finds it from joinSecret.
    await table.putItem({ Item: { pk: `JOIN#${await sha256(body.joinSecret)}`, sk: '-', accountId: body.accountId } });
    return { token: await issue(body.accountId, 'app', body.deviceName, body.install) };
  }

  // The account's object goes near its first computer (the pairing code's), else this App. Through the relay it must be in
  // Japan: elsewhere the App retries with a new key (a new account id), up to twice.
  async function placeAccount(body, request) {
    const bridge = body.code && (await table.getItem({ Key: await pairKey(body.code) })).Item?.edge;
    const edge = bridge || edgeOf(request);
    const colo = await place(body.accountId, locationHint(edge)).catch(() => ''); // unknown: kept
    if (edge.relay && colo && !JAPAN.has(colo) && Number(body.retry || 0) < 2) throw new HTTPError(425, 'Placing the account; retry with a new key.');
  }

  async function recover({ body, ...request }) {
    need(body, 'joinSecret', 'deviceName');
    await perIp('recover', request, 5);
    const digest = await sha256(body.joinSecret);
    const account = (await table.getItem({ Key: { pk: `JOIN#${digest}`, sk: '-' }, ConsistentRead: true })).Item?.accountId;
    if (!account || !compareDigest((await meta(account)).joinSecretHash ?? '', digest)) {
      throw new HTTPError(403, 'Recovery phrase does not match an account.');
    }
    await rate(`recover#${account}`, 5);
    return { token: await issue(account, 'app', body.deviceName, body.install), accountId: account };
  }

  // The client picks the code (a hash of its link's secret; format checked by Body); older Bridges let pair/start pick one.
  async function newCode(code, item) {
    if (await conditional(async () => table.putItem({ Item: { ...await pairKey(code), ...item, ttl: nowInt() + PAIR_SECONDS },
      ConditionExpression: 'attribute_not_exists(pk)' })) === false) throw new HTTPError(409, 'Code in use.');
  }

  async function pairCreate({ body, auth: caller }) {
    need(body, 'code', 'sealed');
    await ensureMeta(caller);
    await newCode(body.code, { kind: 'app', accountId: caller.accountId, by: caller.tokenHash ?? '', sealed: body.sealed });
    return { expiresIn: PAIR_SECONDS, web: env.WEB_URL ?? '', ...api() };
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
    return { code, poll, expiresIn: PAIR_SECONDS, web: env.WEB_URL ?? '', ...api() };
  }

  async function pairApprove({ body, auth: caller }) {
    need(body, 'code', 'sealed');
    await ensureMeta(caller);
    const Key = await pairKey(body.code);
    await roomFor(caller.accountId, (await table.getItem({ Key, ConsistentRead: true })).Item?.deviceName);
    const row = await conditional(() => table.updateItem({ Key, ReturnValues: 'ALL_NEW',
      UpdateExpression: 'SET accountId = :account, sealed = :sealed, approvedBy = :by, #by = :token',
      ConditionExpression: 'attribute_exists(pk) AND kind = :bridge AND #ttl > :now AND attribute_not_exists(accountId)',
      ExpressionAttributeNames: { '#ttl': 'ttl', '#by': 'by' }, ExpressionAttributeValues: { ':account': caller.accountId,
        ':sealed': body.sealed, ':bridge': 'bridge', ':by': caller.deviceName || 'Baton', ':token': caller.tokenHash ?? '', ':now': nowInt() } }));
    if (!row) throw new HTTPError(404, GONE);
    return { deviceName: row.Attributes.deviceName };
  }

  async function pairWait({ body }) {
    // The computer's token is issued only here, so no row ever holds one.
    need(body, 'code', 'poll');
    let row = (await table.getItem({ Key: await pairKey(body.code), ConsistentRead: true })).Item || {};
    if (row.kind !== 'bridge' || Math.trunc(row.ttl ?? 0) <= Date.now() / 1000 || !compareDigest(row.pollHash ?? '', await sha256(body.poll))) {
      throw new HTTPError(404, GONE);
    }
    if (!('accountId' in row)) return { pending: true };
    row = await take(body.code, 'pollHash = :poll AND attribute_exists(accountId)', { ':poll': await sha256(body.poll) });
    await roomFor(row.accountId, row.deviceName); // again: other codes may have been approved meanwhile
    return joined(row, 'bridge', row.deviceName, '', { approvedBy: row.approvedBy });
  }

  // ---- Removal, rotation, deletion ----

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

  // K' sealed under the K the leaving device also holds, its tokens deleted and the recovery index moved, in ONE
  // transaction: it can never read the chain, the old joinSecret never outlives the removal, and `head = fp` makes a
  // second rotation from the same K fail instead of forking the chain.
  async function rotateAndRevoke(account, current, rotation, digests) {
    const chain = (current.rotations ?? []).filter((entry) => entry.fp !== rotation.fp).slice(-(MAX_ROTATIONS - 1));
    if (rotation.next === rotation.fp || chain.some((entry) => entry.fp === rotation.next)) throw new HTTPError(409, 'A new account key is required.');
    const join = await sha256(rotation.joinSecret);
    const update = { Key: { pk: `ACCOUNT#${account}`, sk: 'META' }, ConditionExpression: 'head = :fp',
      UpdateExpression: 'SET joinSecretHash = :hash, head = :next, rotations = :chain',
      ExpressionAttributeValues: { ':hash': join, ':next': rotation.next, ':fp': rotation.fp,
        ':chain': [...chain, { fp: rotation.fp, sealed: rotation.sealed }] } };
    // The recovery index moves only when the join secret changed (one transaction may not touch a row twice).
    const moved = join !== current.joinSecretHash;
    const keys = [...digests.flatMap((digest) => tokenKeys(account, digest)), ...(moved ? [{ pk: `JOIN#${current.joinSecretHash}`, sk: '-' }] : [])];
    try {
      await table.transactWriteItems({ TransactItems: [{ Update: update },
        ...(moved ? [{ Put: { Item: { pk: `JOIN#${join}`, sk: '-', accountId: account } } }] : []),
        ...keys.map((Key) => ({ Delete: { Key } }))] });
    } catch (error) {
      if (error.code !== 'TransactionCanceledException') throw error;
      throw new HTTPError(409, 'The account key changed meanwhile; try again.');
    }
  }

  // A device leaves: a hosted account replaces K at that moment, a self-hosted one (API key) only revokes. Its
  // sockets close (a Bridge told `notice` first), and only then do the remaining Bridges hear of the rotation.
  async function remove(caller, rotation, digests, notice = null) {
    if (caller.kind === 'bridge') throw new HTTPError(403, 'Remove devices from an App.');
    const account = caller.accountId;
    const current = await meta(account);
    const hosted = !!current.joinSecretHash;
    if (hosted && !rotation) throw new HTTPError(400, 'Removing a device needs a new account key.');
    if (hosted) await rotateAndRevoke(account, current, rotation, digests);
    await drop(account, digests, notice, !hosted);
    for (const item of hosted ? await sockets.query(account, 'bridge') : []) {
      try {
        await sockets.post(env.WS_API_ENDPOINT ?? '', item.connectionId, { action: 'account_rotated' });
      } catch {}
    }
  }

  // Tokens (unless already gone in the rotation), the push registrations made with them, their sockets.
  async function drop(account, digests, notice = null, rows = true) {
    if (!digests.length) return;
    const pushes = (await table.query({ KeyConditionExpression: '#pk = :pk', ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':pk': `PUSH_DEVICE#${account}` } })).Items;
    for (const digest of digests) {
      for (const key of [...(rows ? tokenKeys(account, digest) : []), ...pushes.filter((push) => push.tokenHash === digest)]) {
        await table.deleteItem({ Key: { pk: key.pk, sk: key.sk } });
      }
      await close(account, digest, notice);
    }
  }

  const computerTokens = async (account, name) => (await tokenRows(account))
    .filter((row) => row.kind === 'bridge' && row.deviceName === name).map((row) => row.sk.slice(6));

  async function revoke({ body, auth: caller }) {
    // No id: log out. An id: remove another App of the account (a lost phone).
    if (!body.id) {
      await drop(caller.accountId, caller.tokenHash ? [caller.tokenHash] : []);
      return { ok: true };
    }
    const digest = (await tokenRows(caller.accountId)).find((row) => row.sk.slice(6, 18) === body.id && row.kind === 'app')?.sk.slice(6);
    if (!digest || digest === caller.tokenHash) throw new HTTPError(404, 'No such App in this account.');
    await remove(caller, body.rotation, [digest]);
    return { ok: true };
  }

  async function deleteAccount({ auth: caller }) {
    const account = caller.accountId;
    if (caller.kind !== 'app' || !(await meta(account)).joinSecretHash) {
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
          if (row.sk === 'META') await table.deleteItem({ Key: { pk: `JOIN#${row.joinSecretHash}`, sk: '-' } });
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
    ['/api/pair/wait', pairWait], ['/api/tokens/revoke', revoke],
  ].map(([path, handler]) => ({ method: 'POST', path, body: Body, handler }));
  routes.push({ method: 'POST', path: '/api/account/delete', handler: deleteAccount });
  return { routes, remove, computerTokens, listTokens, meta };
}
