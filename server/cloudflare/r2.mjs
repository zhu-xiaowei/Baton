// R2 temporary credentials for one account's prefix t/<accountId>/ (Cloudflare API; the response has no
// expiry, so it is ours). Cached in the account object's storage, refreshed early, one refresh at a time.
const LIFETIME = 3600;
const REFRESH_BEFORE = 600;

export const r2Configured = (env) => !!(env.FILES && env.R2_BUCKET && env.CF_ACCOUNT_ID && env.R2_API_TOKEN && env.R2_PARENT_KEY_ID);

export function storageInfo(env, accountId) {
  if (!r2Configured(env) || !/^[0-9a-f]{16}$/.test(accountId)) return null;
  return { bucket: env.R2_BUCKET, region: 'auto', accountId, endpoint: `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com` };
}

export function createCredentials(env, storage) {
  let pending = null;

  async function issue(accountId) {
    const issuedAt = Date.now() / 1000;
    const reply = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/r2/temp-access-credentials`, {
      method: 'POST', headers: { authorization: `Bearer ${env.R2_API_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ bucket: env.R2_BUCKET, parentAccessKeyId: env.R2_PARENT_KEY_ID, permission: 'object-read-write',
        ttlSeconds: LIFETIME, prefixes: [`t/${accountId}/`] }) });
    const result = reply.ok ? (await reply.json()).result : null;
    if (!result?.accessKeyId) throw new Error(`R2 credentials not issued (${reply.status})`);
    const value = { accessKeyId: result.accessKeyId, secretAccessKey: result.secretAccessKey, sessionToken: result.sessionToken,
      expiresAt: Math.floor(issuedAt + LIFETIME - 30) };
    await storage.put('r2', { accountId, ...value });
    return value;
  }

  // null when R2 is not configured; the old credentials while they last if a refresh fails (429, 5xx).
  return async function credentials(accountId) {
    if (!storageInfo(env, accountId)) return null;
    const cached = await storage.get('r2');
    const now = Date.now() / 1000;
    const usable = cached?.accountId === accountId && cached.expiresAt > now;
    if (usable && cached.expiresAt - now > REFRESH_BEFORE) return strip(cached);
    pending ||= issue(accountId).finally(() => { pending = null; });
    try {
      return await pending;
    } catch (error) {
      if (usable) return strip(cached);
      throw error;
    }
  };
}

const strip = ({ accountId, ...value }) => value;
