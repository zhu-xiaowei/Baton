// WebSocket connections in ConnectionsTable and API Gateway @connections: which socket is a device's
// current Bridge, sending, closing, and the v2 direct-channel join (bridge_data ⇄ control socket).
import { nowInt, randomHex, sha256 } from '../core/util.mjs';
import { call } from './aws.mjs';
import { dataEndpoint, issueCredentials, rpcInfo, storageInfo } from './credentials.mjs';

const JOIN_TICKET_SECONDS = 60;
// json.dumps' default ensure_ascii, as the owner key was hashed.
const ascii = (text) => text.replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
const pad16 = (value) => String(value).padStart(16, '0');
const ticketKey = async (token) => `RPCJOIN#${await sha256(token)}`;
export const bridgeOwnerKey = async (accountId, device) => `BRIDGE#${await sha256(ascii(JSON.stringify([accountId, device])))}`;
export const connectionOrder = (record) => record.connectionOrder
  || `${pad16(Math.trunc(record.connectedAt ?? 0) * 1000)}:${record.connectionId}`;

function bridgeConnectionFresh(record) {
  if (!('ttl' in record)) return true;
  const lastSeen = Math.trunc(record.ttl) - 86400;
  return lastSeen + Math.trunc(record.heartbeatInterval ?? 240) + 5 >= Date.now() / 1000;
}

export function createSockets({ table, devices, log = console.log }) {
  const get = async (connectionId) => (await table.getItem({ Key: { connectionId }, ConsistentRead: true })).Item;
  const byRole = (accountId, role) => ({ IndexName: 'accountId-role-index', KeyConditionExpression: '#a = :a AND #r = :r',
    ExpressionAttributeNames: { '#a': 'accountId', '#r': 'role' }, ExpressionAttributeValues: { ':a': accountId, ':r': role } });
  async function* pages(params) {
    for (;;) {
      const page = await table.query(params);
      yield page.Items;
      if (!page.LastEvaluatedKey) return;
      params = { ...params, ExclusiveStartKey: page.LastEvaluatedKey };
    }
  }

  // Active connections of a role (accountId-role-index); for Bridges only each device's current one.
  async function query(accountId, role, device = '') {
    if (role === 'bridge' && device) {
      const owner = (await get(await bridgeOwnerKey(accountId, device))) ?? {};
      if (owner.activeConnectionId) {
        const record = (await get(owner.activeConnectionId)) ?? {};
        return record.role === role && record.accountId === accountId && record.deviceName === device && bridgeConnectionFresh(record)
          ? [record] : [];
      }
    }
    const items = [];
    for await (const page of pages(byRole(accountId, role))) items.push(...page);
    if (role !== 'bridge') return items;
    const active = new Map();
    const owners = new Map();
    for (const item of items) {
      const name = item.deviceName ?? '';
      let owner = {};
      for (const key of new Set([await bridgeOwnerKey(accountId, name), item.bridgeOwner].filter(Boolean))) {
        if (!owners.has(key)) owners.set(key, (await get(key)) ?? {});
        owner = owners.get(key);
        if (owner.activeConnectionId) break;
      }
      const currentId = owner.activeConnectionId ?? item.connectionId;
      if (item.bridgeOwner && !owner.activeConnectionId) continue;
      const record = await get(currentId);
      if (!record || record.role !== role || record.accountId !== accountId) continue;
      if ((record.deviceName ?? '') !== name || !bridgeConnectionFresh(record)) continue;
      const identity = name || currentId;
      if (!active.has(identity) || connectionOrder(record) > connectionOrder(active.get(identity))) active.set(identity, record);
    }
    return [...active.values()];
  }

  // Sends data to a connection: false when it is gone (its row is removed).
  async function post(endpoint, connectionId, data) {
    try {
      await call('execute-api', { url: `${endpoint}/@connections/${encodeURIComponent(connectionId)}`, body: JSON.stringify(data) });
      return true;
    } catch (error) {
      if (error.code !== 'GoneException') throw error;
      try {
        await table.deleteItem({ Key: { connectionId } });
      } catch {}
      return false;
    }
  }

  async function deleteConnection(endpoint, connectionId) {
    try {
      await call('execute-api', { method: 'DELETE', url: `${endpoint}/@connections/${encodeURIComponent(connectionId)}` });
    } catch (error) {
      if (error.code !== 'GoneException') throw error;
    }
  }

  // Remove the connection and tell its peers.
  async function handleDisconnect(connectionId, endpoint = null) {
    let connection = null;
    try {
      connection = endpoint ? await get(connectionId) : null;
    } catch {}
    try {
      await table.deleteItem({ Key: { connectionId } });
    } catch {}
    try {
      await directRpcDisconnect(connection);
    } catch {
      log('Direct RPC disconnect notification failed');
    }
    return { statusCode: 200 };
  }

  async function retireBridgeConnection(connectionId, endpoint, replaced = true) {
    if (replaced) {
      try {
        await post(endpoint, connectionId, { action: 'bridge_replaced' });
      } catch {}
    }
    try {
      await deleteConnection(endpoint, connectionId);
    } catch {
      log(`Bridge socket cleanup deferred: ${connectionId}`);
    }
    await handleDisconnect(connectionId, endpoint);
  }

  async function claimBridgeConnection(item, endpoint) {
    let previous;
    try {
      previous = (await table.updateItem({ Key: { connectionId: item.bridgeOwner },
        UpdateExpression: 'SET activeConnectionId = :connection, connectionOrder = :order, #ttl = :ttl',
        ConditionExpression: 'attribute_not_exists(connectionOrder) OR connectionOrder <= :order', ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':connection': item.connectionId, ':order': item.connectionOrder, ':ttl': item.ttl },
        ReturnValues: 'ALL_OLD' })).Attributes ?? {};
    } catch (error) {
      if (error.code !== 'ConditionalCheckFailedException') throw error;
      await table.deleteItem({ Key: { connectionId: item.connectionId } });
      return false;
    }
    const previousId = previous.activeConnectionId;
    if (previousId && previousId !== item.connectionId) await retireBridgeConnection(previousId, endpoint);
    for await (const page of pages(byRole(item.accountId, 'bridge'))) {
      for (const candidate of page) {
        if (![previousId, item.connectionId].includes(candidate.connectionId) && candidate.deviceName === item.deviceName
          && connectionOrder(candidate) < connectionOrder(item)) await retireBridgeConnection(candidate.connectionId, endpoint);
      }
    }
    return true;
  }

  // Tell every Bridge socket of a removed device to uninstall itself, then close it.
  async function disconnectRemovedBridge(accountId, endpoint, device) {
    for await (const page of pages(byRole(accountId, 'bridge'))) {
      for (const item of page) {
        if (item.deviceName !== device) continue;
        try {
          await post(endpoint, item.connectionId, { action: 'device_removed' });
        } catch {}
        await retireBridgeConnection(item.connectionId, endpoint, false);
      }
    }
  }

  // ---- v2 direct channel: a Bridge binds a `bridge_data` socket on the data API to its control connection ----

  async function notifyApps(accountId) {
    const apps = await query(accountId, 'app_data');
    if (!apps.length) return;
    const message = { action: 'direct_rpc', type: 'bridges', rpc: await rpcInfo(accountId, await query(accountId, 'bridge')) };
    for (const app of apps) await post(dataEndpoint(), app.connectionId, message);
  }

  async function handleDirectRpc(body, conn, connectionId, endpoint) {
    const operation = body.op;
    const role = conn.role;
    const accountId = conn.accountId ?? '';
    if (operation === 'credentials' && role === 'bridge') {
      await post(endpoint, connectionId, { action: 'direct_rpc', type: 'credentials', endpoint: dataEndpoint(), region: process.env.AWS_REGION,
        credentials: await issueCredentials(accountId), storage: storageInfo(accountId) });
      return { statusCode: 200 };
    }
    if (operation === 'bridge_token' && role === 'bridge' && conn.deviceName) {
      const token = randomHex(32);
      await table.putItem({ Item: { connectionId: await ticketKey(token), accountId, role: 'rpc_join', controlId: connectionId,
        deviceName: conn.deviceName, ttl: nowInt() + JOIN_TICKET_SECONDS } });
      await post(endpoint, connectionId, { action: 'direct_rpc', type: 'token', token });
      return { statusCode: 200 };
    }
    if (operation === 'bridge_join' && role === 'bridge_data') {
      const token = body.token;
      let ticket = null;
      if (typeof token === 'string' && /^[0-9a-f]{64}$/.test(token)) {
        const key = await ticketKey(token);
        ticket = await get(key);
        await table.deleteItem({ Key: { connectionId: key } });
      }
      let current = [];
      if (ticket && ticket.accountId === accountId && Math.trunc(ticket.ttl ?? 0) >= Date.now() / 1000) {
        current = await query(accountId, 'bridge', ticket.deviceName);
      }
      if (!current.length || current[0].connectionId !== ticket.controlId) {
        await post(endpoint, connectionId, { action: 'direct_rpc', type: 'error' });
        return { statusCode: 403 };
      }
      // The end-to-end session key (e2ee.mjs) and K's fingerprint, relayed to Apps as they are.
      let { pub, fp } = body;
      if (!(typeof pub === 'string' && /^[A-Za-z0-9+/]{86}[A-Za-z0-9+/=]{2}$/.test(pub) && typeof fp === 'string' && /^[0-9a-f]{16}$/.test(fp))) {
        pub = fp = '';
      }
      await table.updateItem({ Key: { connectionId: ticket.controlId }, UpdateExpression: 'SET rpcDataId = :data, rpcPub = :pub, rpcFp = :fp',
        ConditionExpression: 'attribute_exists(connectionId)', ExpressionAttributeValues: { ':data': connectionId, ':pub': pub, ':fp': fp } });
      await table.updateItem({ Key: { connectionId }, UpdateExpression: 'SET rpcControlId = :control',
        ConditionExpression: 'attribute_exists(connectionId)', ExpressionAttributeValues: { ':control': ticket.controlId } });
      await post(endpoint, connectionId, { action: 'direct_rpc', type: 'joined' });
      if (typeof body.nameSealed === 'string' && body.nameSealed.length <= 400 && /^[0-9a-f]{32}$/.test(body.nameTag ?? '')) {
        await devices.put(accountId, ticket.deviceName, '', { nameSealed: body.nameSealed, nameTag: body.nameTag }).catch((error) => log(`device row not written: ${error.message}`));
      }
      await notifyApps(accountId);
      return { statusCode: 200 };
    }
    return { statusCode: 403 };
  }

  // Called after the connection row was removed.
  async function directRpcDisconnect(connection) {
    if (!connection) return;
    const role = connection.role;
    if (role === 'bridge_data' && connection.rpcControlId) {
      try {
        await table.updateItem({ Key: { connectionId: connection.rpcControlId }, UpdateExpression: 'REMOVE rpcDataId',
          ConditionExpression: 'rpcDataId = :data', ExpressionAttributeValues: { ':data': connection.connectionId } });
      } catch {
        return;
      }
    } else if (!(role === 'bridge' && connection.rpcDataId)) {
      return;
    }
    await notifyApps(connection.accountId ?? '');
  }

  return { table, devices, get, query, post, deleteConnection, handleDisconnect, retireBridgeConnection, claimBridgeConnection,
    disconnectRemovedBridge, handleDirectRpc };
}
