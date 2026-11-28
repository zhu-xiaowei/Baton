// The REST API: version, sign-in / install tokens, devices, install scripts, accounts and notifications
// behind one authentication middleware. Platform-free: everything outside goes through `ports`.
import { Body, LINK_SECONDS, createAccounts, need } from './accounts.mjs';
import { KeyUnavailable, createAuth } from './auth.mjs';
import { createDevices } from './devices.mjs';
import { createHttp, json, text } from './http.mjs';
import { checkDeviceName, installScript } from './install.mjs';
import { createNotifications } from './notifications.mjs';
import { length, now, nowInt, randomHex } from './util.mjs';

const PROTOCOL_VERSION = 2;
export const PUBLIC = new Set(['/api/version', '/api/account/register', '/api/account/recover', '/api/pair/claim', '/api/pair/start', '/api/pair/wait']);
// Paths only some credential kinds may use: start-token hands out the deployment key, and an
// install script embeds the caller's credential as the new Bridge's.
const KINDS = { '/api/auth/start-token': ['key'], '/api/install': ['key', 'bridge'] };
// Sign-in / install tokens. A token stays valid until its ttl and is tied to the key's name, so
// rotating the key also retires every outstanding token.

/**
 * ports: {
 *   env, log,
 *   table: SystemTable (DynamoDB operations with plain values: getItem, putItem, updateItem, deleteItem, query, transactWriteItems),
 *   currentKey(): the deployment API key (throws KeyUnavailable),
 *   sockets: { query(account, role, device?), post(endpoint, id, data), deleteConnection(endpoint, id), handleDisconnect(id),
 *     disconnectRemovedBridge(account, endpoint, device) },
 *   rpcInfo(account, bridges): direct-channel addresses and credentials for /devices,
 *   presign(): the Bridge package URL or null, relayPost(url, body, timeoutSec): one push relay POST,
 *   web?(context): the web app's files, place?(account, hint): creates the account's object near hint, its colo (Cloudflare),
 * }
 */
export function createServer(ports) {
  const { env, table, sockets, log } = ports;
  const auth = createAuth(ports);
  const devices = createDevices(table);
  const accounts = createAccounts({ env, table, auth, devices, sockets, log, place: ports.place });
  const notifications = createNotifications(ports);

  async function authenticate(context) {
    const path = context.path;
    if (context.method === 'OPTIONS' || !path.startsWith('/api/') || PUBLIC.has(path)) return null;
    let resolved;
    try {
      resolved = await auth.resolve(context.headers.get('x-api-key') ?? '');
    } catch (error) {
      if (error instanceof KeyUnavailable) return json({ error: 'temporarily unavailable' }, 503);
      throw error;
    }
    if (!resolved) return json({ error: 'unauthorized' }, 401);
    if (!(KINDS[path] ?? [resolved.kind]).includes(resolved.kind)) return json({ error: 'forbidden' }, 403);
    context.auth = resolved;
    return null;
  }

  // The control socket's address, for the App and for a Bridge whose config.json lacks it.
  const wsUrl = () => (env.WS_API_ENDPOINT ? env.WS_API_ENDPOINT.replaceAll('https://', 'wss://') : '');

  async function redeemToken(token) {
    token = (token || '').trim();
    if (!token || length(token) > 128) return null;
    const item = (await table.getItem({ Key: { pk: 'TOKEN', sk: token }, ConsistentRead: true })).Item;
    // DynamoDB TTL deletes lazily, so expiry is checked here.
    if (!item || Math.trunc(item.ttl || 0) < now() || item.keyName !== auth.keyName()) return null;
    return auth.currentKey();
  }

  const script = async (context, key, { name, platform }) => installScript(context, key, name, platform, ports.presign);
  const asText = (result, headers = {}) => (result.text === undefined ? result : text(result.text, 200, headers));

  async function getDevices({ auth: caller }) {
    // Names and online state only; counts come from each Bridge. `rpc` addresses the joined Bridges directly.
    const account = caller.accountId;
    const items = await devices.list(account);
    let bridges = [];
    if (env.CONNECTIONS_TABLE) {
      try {
        bridges = await sockets.query(account, 'bridge');
      } catch (error) {
        log(`bridge connections unavailable: ${error.message}`);
      }
    }
    const online = new Set(bridges.map((row) => row.deviceName ?? ''));
    const result = { protocol: PROTOCOL_VERSION, wsUrl: wsUrl(), notifications: notifications.info(account),
      devices: items.filter((item) => item.deviceName).map((item) => ({ deviceName: item.deviceName,
        deviceDisplayName: item.deviceDisplayName || item.deviceName, ...(item.nameSealed ? { nameSealed: item.nameSealed } : {}), online: online.has(item.deviceName) })) };
    const meta = await accounts.meta(account);
    Object.assign(result, { apps: await accounts.listTokens(account), hosted: accounts.isHosted(meta), phraseSealed: meta.phraseSealed ?? '',
      ...(env.INSTALL_URL && { install: env.INSTALL_URL }), self: (caller.tokenHash ?? '').slice(0, 12) });
    if (env.CONNECTIONS_TABLE) {
      try {
        result.rpc = await ports.rpcInfo(account, bridges);
      } catch (error) {
        log(`rpc credentials unavailable: ${error.message}`);
      }
    }
    return result;
  }

  // Remove a device: its Bridge is told to uninstall itself and disconnected, then its row goes.
  async function deleteDevice({ body, auth: caller }) {
    need(body, 'deviceName');
    const account = caller.accountId;
    // The Bridge is told to uninstall before its sockets close.
    await accounts.remove(caller, await accounts.computerTokens(account, body.deviceName), 'device_removed');
    const endpoint = env.WS_API_ENDPOINT ?? '';
    if (endpoint) {
      try {
        await sockets.disconnectRemovedBridge(account, endpoint, body.deviceName);
      } catch (error) {
        log(`removed bridge disconnect failed: ${error.message}`);
      }
    }
    await devices.delete(account, body.deviceName);
    return { ok: true };
  }

  const routes = [
    { method: 'POST', path: '/api/bridge/delete-device', body: Body, handler: deleteDevice },
    { method: 'GET', path: '/api/bridge/devices', handler: getDevices },
    { method: 'GET', path: '/api/bridge/device-name/validate', query: [['name', { required: true }], ['mode', { default: 'identity' }],
      ['current', { default: '' }]], handler: async ({ auth: caller, query }) => {
      const [name, error] = checkDeviceName(await devices.list(caller.accountId), query.name, query.mode, query.current);
      return { ok: !error, name, error };
    } },
    ...notifications.routes,
    ...accounts.routes,
    // Every installed Bridge's update path.
    { method: 'GET', path: '/api/install', query: [['name', { default: null }], ['platform', { default: '' }]],
      handler: async (context) => asText(await script(context, context.headers.get('x-api-key') ?? '', context.query)) },
    // `entries`: other hosts reaching this API (the mainland-China relay); `country` tells a client whether to use them.
    { method: 'GET', path: '/api/version', handler: async (context) => {
      const version = env.APP_VERSION ?? 'dev';
      const entries = env.API_ENTRIES ? { entries: env.API_ENTRIES.split(','), country: context.headers.get('cf-ipcountry') ?? '',
        ipToken: await accounts.ipToken(context) } : {};
      return { version, bridgeVersion: env.BRIDGE_VERSION ?? version, ...entries };
    } },
    // Token for Setup's Start URL, QR code and install command.
    { method: 'POST', path: '/api/auth/start-token', handler: async () => {
      const token = randomHex(16);
      await table.putItem({ Item: { pk: 'TOKEN', sk: token, keyName: auth.keyName(), ttl: nowInt() + LINK_SECONDS } });
      return { token, expiresIn: LINK_SECONDS };
    } },
    // Outside /api/, so API Gateway does not require the key; the token stands in for it.
    { method: 'POST', path: '/auth/exchange-token', body: [['token', { required: true }]], handler: async ({ body }) => {
      const key = await redeemToken(body.token);
      return key ? { apiKey: key } : json({ error: 'invalid or expired' }, 401);
    } },
    { method: 'GET', path: '/auth/install', query: [['t', { default: '' }], ['name', { default: null }], ['platform', { default: '' }]],
      handler: async (context) => {
        const key = await redeemToken(context.query.t);
        if (!key) return text("echo 'Install command expired. Copy a new one from Baton Setup.' >&2\nexit 1\n", 403);
        return asText(await script(context, key, context.query), { 'cache-control': 'no-store' });
      } },
    // Hosted install command: no credential, the computer then joins an account by QR code.
    { method: 'GET', path: '/install', query: [['name', { default: null }], ['platform', { default: '' }]], handler: async (context) => {
      if (env.OPEN_REGISTRATION !== 'true') {
        return text("echo 'This server has no public install; copy the command from Setup.' >&2\nexit 1\n", 404);
      }
      return asText(await script(context, '', context.query));
    } },
  ];

  const handle = createHttp({ routes, authenticate, web: ports.web, onError: (error) => log(error.stack || String(error)),
    keyUnavailable: (error) => error instanceof KeyUnavailable });
  return { handle };
}
