// Resolves a request's credential (deployment API key or device token) to its account, once per request.
import { compareDigest, now, sha256 } from './util.mjs';

const SEEN_SECONDS = 3600;

// The deployment key could not be read, so a key can be neither accepted nor rejected (a 503).
export class KeyUnavailable extends Error {}

export const tokenHash = (token) => sha256(token);
export const TOKEN = /^bt_([0-9a-f]{16})_[\w-]{43}$/;

// `currentKey()` reads the deployment's single API key (AWS: from API Gateway, never from a table).
export function createAuth({ env, table, currentKey, log }) {
  const seen = new Map();

  async function isCurrent(key) {
    const current = await currentKey();
    return !!(key && current) && compareDigest(key, current);
  }

  // Pinned at deploy (install.sh) so a rotated key keeps the data; any other key still gets its own
  // empty account. KeyUnavailable propagates (503) rather than guessing.
  async function accountId(key) {
    if (env.ACCOUNT_ID && await isCurrent(key)) return env.ACCOUNT_ID;
    return (await sha256(key)).slice(0, 16);
  }

  // Cloudflare: the token names its account, whose own row is read (no global index).
  async function listed(credential, digest) {
    const account = TOKEN.exec(credential)?.[1];
    const row = account && (await table.getItem({ Key: { pk: `ACCOUNT#${account}`, sk: `TOKEN#${digest}` }, ConsistentRead: true })).Item;
    return row && { ...row, accountId: account };
  }

  // { accountId, kind, deviceName, tokenHash } or null.
  async function resolve(credential) {
    if (!credential) return null;
    if (!credential.startsWith('bt_')) return await isCurrent(credential) ? { accountId: await accountId(credential), kind: 'key' } : null;
    // Read on every request, not cached: a revoked token must stop on every instance at once.
    const digest = await tokenHash(credential);
    const time = now();
    // Consistent reads: a token issued a moment ago must resolve (a refused paired Bridge uninstalls itself).
    const row = env.TOKENS_BY_ACCOUNT ? await listed(credential, digest)
      : (await table.getItem({ Key: { pk: `TOKEN#${digest}`, sk: '-' }, ConsistentRead: true })).Item;
    if (!row || !(await table.getItem({ Key: { pk: `ACCOUNT#${row.accountId}`, sk: 'META' }, ConsistentRead: true })).Item) return null;
    const result = { accountId: row.accountId, kind: row.kind, deviceName: row.deviceName ?? '', tokenHash: digest };
    // At most hourly: the stored value where the row carries it (Cloudflare, survives eviction), else per instance.
    if (Math.max(seen.get(digest) ?? 0, row.lastSeen ?? 0) < time - SEEN_SECONDS) {
      seen.set(digest, time);
      try {
        await table.updateItem({ Key: { pk: `ACCOUNT#${row.accountId}`, sk: `TOKEN#${digest}` },
          UpdateExpression: 'SET lastSeen = :now', ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeValues: { ':now': Math.floor(time) } });
      } catch (error) {
        log(`lastSeen not written: ${error.message}`);
      }
    }
    return result;
  }

  return { resolve, isCurrent, accountId, keyName: () => env.API_KEY_NAME ?? '', currentKey };
}
