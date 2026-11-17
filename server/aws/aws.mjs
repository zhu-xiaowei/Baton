// AWS API calls with fetch + SigV4 (bridge/transfer-store.mjs), the Lambda role's credentials and
// botocore's legacy retry policy: DynamoDB 10 attempts from 50 ms, others 5 from 0-1 s, doubling.
import { signHeaders } from '../../bridge/transfer-store.mjs';

export const region = () => process.env.AWS_REGION;
export const credentials = () => ({ accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  sessionToken: process.env.AWS_SESSION_TOKEN });

export class AwsError extends Error {
  constructor(code, message, status) {
    super(`${code}: ${message}`);
    Object.assign(this, { code, status });
  }
}

const RETRIED = /Throttl|TooManyRequests|ProvisionedThroughputExceeded|TransactionInProgress|RequestLimitExceeded|LimitExceeded|SlowDown/;
const RETRIED_STATUS = [429, 500, 502, 503, 504, 509];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One signed request; resolves the response text, throws AwsError with the service's error code.
export async function call(service, { method = 'POST', url, headers = {}, body = '', signRegion = region() }) {
  const attempts = service === 'dynamodb' ? 10 : 5;
  for (let attempt = 1; ; attempt++) {
    let error;
    try {
      const signed = await signHeaders({ method, url, region: signRegion, service, credentials: credentials(), headers, body });
      const response = await fetch(url, { method, headers: { ...headers, ...signed }, body: method === 'GET' ? undefined : body });
      const text = await response.text();
      if (response.ok) return text;
      error = parseError(response, text);
    } catch (thrown) {
      error = thrown; // the network, as botocore's socket errors
    }
    const retry = !(error instanceof AwsError) || RETRIED_STATUS.includes(error.status) || RETRIED.test(error.code);
    if (!retry || attempt >= attempts) throw error;
    await sleep(service === 'dynamodb' ? 50 * 2 ** (attempt - 1) : Math.random() * 1000 * 2 ** (attempt - 1));
  }
}

function parseError(response, text) {
  let code = response.headers.get('x-amzn-errortype') ?? '';
  let message = text;
  try {
    const body = JSON.parse(text);
    code ||= body.__type ?? body.code ?? '';
    message = body.message ?? body.Message ?? text;
  } catch {
    code ||= /<Code>([^<]*)<\/Code>/.exec(text)?.[1] ?? '';
    message = /<Message>([^<]*)<\/Message>/.exec(text)?.[1] ?? text;
  }
  return new AwsError(code.split(':')[0].split('#').pop() || String(response.status), message, response.status);
}
