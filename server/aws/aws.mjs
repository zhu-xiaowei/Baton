// AWS API calls with SigV4 (bridge/transfer-store.mjs), the Lambda role's credentials and botocore's
// client behaviour (retries, timeouts, DynamoDB's CRC32 check).
import https from 'node:https';
import zlib from 'node:zlib';
import { signHeaders } from '../../bridge/transfer-store.mjs';

// Connections stay open while the instance is warm, as botocore's do (fetch closes them after 4 s idle).
const agent = new https.Agent({ keepAlive: true });
let send = (url, { method, headers, body, timeoutMs }) => new Promise((resolve, reject) => {
  const request = https.request(url, { method, agent, timeout: timeoutMs,
    headers: { ...headers, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) } }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString() }));
    response.on('error', reject);
  });
  request.on('timeout', () => request.destroy(new Error('timed out')));
  request.on('error', reject);
  request.end(body || undefined);
});
// One HTTPS request: { status, headers (lower-case names), text }. Tests replace it.
export const request = (url, options) => send(url, options);
export const setRequest = (next) => { send = next; };

export const region = () => process.env.AWS_REGION;
export const credentials = () => ({ accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  sessionToken: process.env.AWS_SESSION_TOKEN });

export class AwsError extends Error {
  constructor(code, message, status) {
    super(`${code}: ${message}`);
    Object.assign(this, { code, status });
  }
}

// botocore's default "standard" retry mode: DynamoDB 4 attempts, others 3; full-jitter backoff from 1 s for
// throttling, else 25 ms (DynamoDB) or 50 ms, doubling up to 20 s; x-amz-retry-after; a retry quota per service.
const TRANSIENT_CODES = ['RequestTimeout', 'RequestTimeoutException', 'PriorRequestNotComplete'];
const THROTTLING_CODES = ['Throttling', 'ThrottlingException', 'ThrottledException', 'RequestThrottledException',
  'TooManyRequestsException', 'ProvisionedThroughputExceededException', 'TransactionInProgressException', 'RequestLimitExceeded',
  'BandwidthLimitExceeded', 'LimitExceededException', 'RequestThrottled', 'SlowDown', 'PriorRequestNotComplete', 'EC2ThrottledException'];
const RETRIED_CODES = { dynamodb: ['ReplicatedWriteConflictException'], sts: ['IDPCommunicationError'] };
const quotas = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One signed request; resolves the response text, throws AwsError with the service's error code.
export async function call(service, { method = 'POST', url, headers = {}, body = '', signRegion = region() }) {
  const attempts = service === 'dynamodb' ? 4 : 3;
  let acquired = 0;
  for (let attempt = 1; ; attempt++) {
    let error;
    let response;
    let badChecksum = false;
    try {
      const signed = await signHeaders({ method, url, region: signRegion, service, credentials: credentials(), headers, body });
      response = await request(url, { method, headers: { ...headers, ...signed }, body, timeoutMs: 60_000 });
      const crc = response.headers['x-amz-crc32'];
      badChecksum = service === 'dynamodb' && crc !== undefined && Number(crc) !== zlib.crc32(response.text);
      if (response.status < 300) {
        quotas.set(service, Math.min(500, (quotas.get(service) ?? 500) + (acquired || 1)));
        if (!badChecksum) return response.text;
      } else {
        error = parseError(response);
      }
    } catch (thrown) {
      error = thrown; // the network, as botocore's connection errors
    }
    const throttling = error instanceof AwsError && (THROTTLING_CODES.includes(error.code) || error.status === 429);
    const retryable = badChecksum || !(error instanceof AwsError) || throttling || TRANSIENT_CODES.includes(error.code)
      || [500, 502, 503, 504].includes(error.status) || !!RETRIED_CODES[service]?.includes(error.code);
    const cost = throttling ? 5 : 14;
    const available = quotas.get(service) ?? 500;
    if (!retryable || attempt >= attempts || cost > available) {
      if (badChecksum) return response.text;
      throw error;
    }
    quotas.set(service, available - cost);
    acquired = cost;
    let delay = Math.random() * Math.min((throttling ? 1 : service === 'dynamodb' ? 0.025 : 0.05) * 2 ** (attempt - 1), 20);
    const after = /^\s*\+?\d+\s*$/.test(response?.headers['x-amz-retry-after'] ?? '') ? Number(response.headers['x-amz-retry-after']) / 1000 : null;
    if (after !== null) delay = Math.max(delay, Math.min(after, delay + 5));
    await sleep(delay * 1000);
  }
}

function parseError({ status, headers, text }) {
  let code = headers['x-amzn-errortype'] ?? '';
  let message = text;
  try {
    const body = JSON.parse(text);
    code ||= body.__type ?? body.code ?? '';
    message = body.message ?? body.Message ?? text;
  } catch {
    code ||= /<Code>([^<]*)<\/Code>/.exec(text)?.[1] ?? '';
    message = /<Message>([^<]*)<\/Message>/.exec(text)?.[1] ?? text;
  }
  return new AwsError(code.split(':')[0].split('#').pop() || String(status), message, status);
}
