// The control and data WebSocket APIs' Lambda: connections and their owner records, heartbeats and the
// v2 direct-channel join. Messages between App and Bridge do not pass here (data API integration).
import { KeyUnavailable, createAuth } from '../core/auth.mjs';
import { createDevices } from '../core/devices.mjs';
import { nowInt } from '../core/util.mjs';
import { currentKey } from './api-key.mjs';
import { createTable } from './dynamodb.mjs';
import { bridgeOwnerKey, createSockets } from './sockets.mjs';

const DATA_ROLES = ['app_data', 'bridge_data'];
let state;
const init = () => (state ||= (() => {
  const system = createTable(process.env.SYSTEM_TABLE);
  const sockets = createSockets({ table: createTable(process.env.CONNECTIONS_TABLE), devices: createDevices(system) });
  return { sockets, auth: createAuth({ env: process.env, table: system, currentKey, log: console.log }) };
})());

export async function handler(event) {
  const { sockets, auth } = init();
  const context = event.requestContext ?? {};
  const connectionId = context.connectionId ?? '';
  const endpoint = `https://${context.domainName ?? ''}/${context.stage ?? ''}`;
  if (context.routeKey === '$connect') return connect(event, context, connectionId, endpoint, sockets, auth);
  if (context.routeKey === '$disconnect') return sockets.handleDisconnect(connectionId, endpoint);
  if (context.routeKey === '$default') return message(event, connectionId, endpoint, sockets);
  return { statusCode: 400 };
}

async function connect(event, context, connectionId, connectedEndpoint, sockets, auth) {
  const qs = event.queryStringParameters || {};
  const role = qs.role ?? 'app'; // "app" or "bridge", or their _data twins on the data API
  const device = qs.device ?? '';
  const version = qs.version ?? '';
  let resolved;
  try {
    resolved = await auth.resolve(qs.apiKey ?? '');
  } catch (error) {
    if (error instanceof KeyUnavailable) return { statusCode: 503 };
    throw error;
  }
  if (!resolved) return { statusCode: 401 };
  // A device token connects only in its own role: a phone cannot pose as a Bridge, nor a Bridge as an App.
  if (resolved.kind !== 'key' && (resolved.kind === 'bridge') !== role.startsWith('bridge')) return { statusCode: 403 };
  // A computer's token is that computer: it cannot connect as another one (and pass the account's limit).
  if (resolved.kind === 'bridge' && device && device !== resolved.deviceName) return { statusCode: 403 };
  const bridgeId = role === 'bridge' ? qs.bridgeId : undefined;
  if (bridgeId !== undefined && !/^[a-f0-9]{32}$/.test(bridgeId)) return { statusCode: 400 };

  const dataEndpoint = process.env.TERMINAL_DIRECT_ENDPOINT;
  if (DATA_ROLES.includes(role) !== (!!dataEndpoint && connectedEndpoint === dataEndpoint)) return { statusCode: 403 };

  const accountId = resolved.accountId;
  const item = { connectionId, accountId, role, connectedAt: nowInt(), ttl: nowInt() + 86400 };
  if (device) item.deviceName = device;
  if (resolved.tokenHash) item.tokenHash = resolved.tokenHash;
  if (role === 'bridge' && version) item.bridgeVersion = version;
  if (role === 'bridge' && device) {
    item.bridgeOwner = await bridgeOwnerKey(accountId, device);
    item.heartbeatInterval = qs.heartbeat === '5' ? 5 : 240;
    const connectedAt = Math.trunc(context.connectedAt || context.requestTimeEpoch || Date.now());
    item.connectionOrder = `${String(connectedAt).padStart(16, '0')}:${connectionId}`;
  }
  if (bridgeId) item.bridgeId = bridgeId;
  await sockets.table.putItem({ Item: item });
  if (item.bridgeOwner) {
    if (!await sockets.claimBridgeConnection(item, connectedEndpoint)) return { statusCode: 409 };
    try { // display only: the connection does not depend on it; a paired computer names itself sealed, with bridge_join
      if (qs.name !== undefined) await sockets.devices.put(accountId, device, qs.name);
    } catch (error) {
      console.log(`device row not written: ${error.message}`);
    }
  }
  return { statusCode: 200 };
}

async function message(event, connectionId, endpoint, sockets) {
  let body;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return { statusCode: 400 };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { statusCode: 400 };
  const action = body.action ?? '';

  // Connection info: if missing (e.g. the table was cleared), force a reconnect, which rewrites the record.
  const conn = await sockets.get(connectionId);
  if (!conn) {
    try {
      await sockets.deleteConnection(endpoint, connectionId);
    } catch {}
    return { statusCode: 200 };
  }
  const role = conn.role ?? 'app';
  const accountId = conn.accountId ?? '';
  if (role === 'bridge' && conn.deviceName) {
    const ownerKey = await bridgeOwnerKey(accountId, conn.deviceName ?? '');
    let owner = (await sockets.get(ownerKey)) ?? {};
    if (!Object.keys(owner).length && conn.bridgeOwner && conn.bridgeOwner !== ownerKey) owner = (await sockets.get(conn.bridgeOwner)) ?? {};
    if ((Object.keys(owner).length || conn.bridgeOwner) && owner.activeConnectionId !== connectionId) {
      await sockets.retireBridgeConnection(connectionId, endpoint, !!owner.activeConnectionId);
      return { statusCode: 200 };
    }
  }
  if (action === 'direct_rpc') return sockets.handleDirectRpc(body, conn, connectionId, endpoint);
  if (DATA_ROLES.includes(role)) return { statusCode: 403 };

  if (action === 'heartbeat') {
    const ttl = nowInt() + 86400;
    try {
      if (conn.bridgeOwner) {
        await sockets.table.updateItem({ Key: { connectionId: conn.bridgeOwner }, UpdateExpression: 'SET #ttl = :ttl',
          ConditionExpression: 'activeConnectionId = :connection', ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':ttl': ttl, ':connection': connectionId } });
      }
      await sockets.table.updateItem({ Key: { connectionId }, UpdateExpression: 'SET #t = :ttl',
        ConditionExpression: 'attribute_exists(connectionId)', ExpressionAttributeNames: { '#t': 'ttl' }, ExpressionAttributeValues: { ':ttl': ttl } });
    } catch (error) {
      if (error.code !== 'ConditionalCheckFailedException') throw error;
      return { statusCode: 200 };
    }
    const response = { action: 'heartbeat', ts: nowInt() };
    if (role === 'bridge') response.bridgeVersion = process.env.BRIDGE_VERSION ?? process.env.APP_VERSION ?? 'dev';
    await sockets.post(endpoint, connectionId, response);
  }
  return { statusCode: 200 };
}
