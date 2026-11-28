// Temporary credentials for the v2 direct channel: Apps and Bridges of one account may post to the data
// API's @connections and read/write that account's transfer prefix t/<accountId>/ (transfer-store.mjs).
import { call } from './aws.mjs';

const CREDENTIAL_SECONDS = 3600;
const CREDENTIAL_REUSE_MARGIN = 600;
const cache = new Map();

export const dataEndpoint = () => process.env.TERMINAL_DIRECT_ENDPOINT ?? '';

// POST @connections/* on the data API: API Gateway authorizes the route template, not one socket.
export function callbackPolicy(endpoint, roleArn, region) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('Invalid callback destination');
  }
  const apiId = url.hostname.split('.')[0];
  const stage = url.pathname.replace(/^\/+|\/+$/g, '');
  if (url.protocol !== 'https:' || endpoint.includes('?') || endpoint.includes('#') || !/^[a-z0-9]+$/.test(apiId)
    || !/^[A-Za-z0-9_-]+$/.test(stage)) throw new Error('Invalid callback destination');
  const [, partition, , , account] = roleArn.split(':');
  return { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'execute-api:ManageConnections',
    Resource: `arn:${partition}:execute-api:${region}:${account}:${apiId}/${stage}/POST/@connections/*` }] };
}

// Where this account's files travel: t/<accountId>/ in the attachment bucket.
export function storageInfo(accountId) {
  const bucket = process.env.BRIDGE_IMAGES_BUCKET ?? '';
  if (!bucket || !/^[0-9a-f]{16}$/.test(accountId)) return null;
  return { bucket, region: process.env.AWS_REGION, accountId,
    accelerate: (process.env.S3_UPLOAD_ACCELERATE ?? 'false').toLowerCase() === 'true' };
}

// The data API, plus reading and writing this account's transfer prefix only.
export function sessionPolicy(accountId, roleArn, region) {
  const policy = callbackPolicy(dataEndpoint(), roleArn, region);
  const storage = storageInfo(accountId);
  if (storage) {
    policy.Statement.push({ Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:AbortMultipartUpload'],
      Resource: `arn:${roleArn.split(':')[1]}:s3:::${storage.bucket}/t/${accountId}/*` });
  }
  return policy;
}

const tag = (xml, name) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];

export async function issueCredentials(accountId) {
  const cached = cache.get(accountId);
  if (cached && cached.expiresAt - Date.now() / 1000 > CREDENTIAL_REUSE_MARGIN) return cached;
  const region = process.env.AWS_REGION;
  const roleArn = process.env.TERMINAL_DIRECT_ROLE_ARN;
  const body = new URLSearchParams({ Action: 'AssumeRole', Version: '2011-06-15', RoleArn: roleArn,
    RoleSessionName: `rpc-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`, DurationSeconds: String(CREDENTIAL_SECONDS),
    Policy: JSON.stringify(sessionPolicy(accountId, roleArn, region)) }).toString();
  const xml = await call('sts', { url: `https://sts.${region}.amazonaws.com/`, body,
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' } });
  const value = { accessKeyId: tag(xml, 'AccessKeyId'), secretAccessKey: tag(xml, 'SecretAccessKey'),
    sessionToken: tag(xml, 'SessionToken'), expiresAt: Math.floor(Date.parse(tag(xml, 'Expiration')) / 1000) };
  if (cache.size > 256) cache.clear();
  cache.set(accountId, value);
  return value;
}

// Bridges an App can address directly, plus data-API credentials (see issueCredentials).
export async function rpcInfo(accountId, bridges) {
  return { bridges: bridges.filter((bridge) => bridge.rpcDataId).map((bridge) => ({ device: bridge.deviceName ?? '', dataId: bridge.rpcDataId,
    ...(bridge.rpcPub ? { pub: bridge.rpcPub } : {}), ...(bridge.rpcFp ? { fp: bridge.rpcFp } : {}) })),
  endpoint: dataEndpoint(), credentials: await issueCredentials(accountId), storage: storageInfo(accountId) };
}
