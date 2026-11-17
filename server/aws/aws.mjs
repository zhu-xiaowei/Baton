// AWS API calls with SigV4 (bridge/transfer-store.mjs) and the Lambda role's credentials.
import https from 'node:https';
import { signHeaders } from '../../bridge/transfer-store.mjs';

// Connections stay open while the instance is warm (fetch would close them after 4 s idle).
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

// Throttling, 5xx and network errors are retried: 3 attempts, full-jitter backoff from 100 ms (1 s when throttled).
const THROTTLED = /Throttl|TooManyRequests|ProvisionedThroughputExceeded|RequestLimitExceeded|LimitExceeded|SlowDown|TransactionInProgress/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One signed request; resolves the response text, throws AwsError with the service's error code.
export async function call(service, { method = 'POST', url, headers = {}, body = '' }) {
  for (let attempt = 1; ; attempt++) {
    let error;
    try {
      const signed = await signHeaders({ method, url, region: region(), service, credentials: credentials(), headers, body });
      const response = await request(url, { method, headers: { ...headers, ...signed }, body, timeoutMs: 10_000 });
      if (response.status < 300) return response.text;
      error = parseError(response);
    } catch (thrown) {
      error = thrown; // the network or a timeout
    }
    const throttled = error instanceof AwsError && (error.status === 429 || THROTTLED.test(error.code));
    if (attempt >= 3 || (error instanceof AwsError && !throttled && error.status < 500)) throw error;
    await sleep(Math.random() * (throttled ? 1000 : 100) * 2 ** (attempt - 1));
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
