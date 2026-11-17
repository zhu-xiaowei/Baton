// The REST API Lambda (API Gateway proxy events), as the Python server ran behind the Lambda Web Adapter.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signHeaders, signUrl } from '../../bridge/transfer-store.mjs';
import { createServer } from '../core/app.mjs';
import { createDevices } from '../core/devices.mjs';
import { pyStrip, unquote } from '../core/py.mjs';
import { currentKey } from './api-key.mjs';
import { credentials, region } from './aws.mjs';
import { rpcInfo } from './credentials.mjs';
import { createTable } from './dynamodb.mjs';
import { createSockets } from './sockets.mjs';
import { web } from './web-files.mjs';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

// Kept-alive by fetch; one fresh retry if the connection was dropped while the Lambda was frozen.
export async function relayPost(url, body, timeoutSec) {
  const host = new URL(url).hostname.split('.');
  const signRegion = host.length > 2 && host[1] === 'lambda-url' ? host[2] : region();
  for (const fresh of [false, true]) {
    try {
      const headers = { 'content-type': 'application/json' };
      const signed = await signHeaders({ method: 'POST', url, region: signRegion, service: 'lambda', credentials: credentials(), headers, body });
      const reply = await fetch(url, { method: 'POST', headers: { ...headers, ...signed }, body, signal: AbortSignal.timeout(Math.ceil(timeoutSec * 1000)) });
      return { status: reply.status, data: await reply.text() };
    } catch (error) {
      if (fresh) throw error;
    }
  }
}

async function presign() {
  const bucket = process.env.BRIDGE_IMAGES_BUCKET ?? '';
  if (!bucket) return null;
  return signUrl({ method: 'GET', host: `${bucket}.s3.${region()}.amazonaws.com`, path: '/install/bridge.tar.gz', region: region(),
    credentials: credentials(), expires: 3600 });
}

// ---- Lambda entry ----
export function createHandler(directory = WEB_DIR) {
  let server;
  async function init() {
    const hasWeb = await fs.stat(directory).then((stat) => stat.isDirectory(), () => false);
    const system = createTable(process.env.SYSTEM_TABLE);
    const sockets = createSockets({ table: createTable(process.env.CONNECTIONS_TABLE), devices: createDevices(system) });
    return createServer({ env: process.env, table: system, currentKey, sockets, rpcInfo, presign, relayPost, log: console.log,
      web: hasWeb ? web(directory) : undefined });
  }
  return async (event) => {
    server ||= await init();
    // Header values reached the Python server as UTF-8 bytes read back as Latin-1.
    const headers = new Headers();
    for (const [name, value] of Object.entries(event.headers ?? {})) {
      if (value !== null) headers.set(name, Buffer.from(String(value), 'utf8').toString('latin1'));
    }
    const query = new URLSearchParams();
    for (const [name, values] of Object.entries(event.multiValueQueryStringParameters ?? {})) for (const value of values ?? []) query.append(name, value);
    if (![...query].length) for (const [name, value] of Object.entries(event.queryStringParameters ?? {})) query.append(name, value);
    const body = event.body === null || event.body === undefined ? undefined : Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
    const method = event.httpMethod;
    const request = new Request(`http://localhost/?${query}`, { method, headers, body: ['GET', 'HEAD'].includes(method) ? undefined : body });
    const forwarded = pyStrip(headers.get('x-forwarded-proto') ?? '');
    // The Web Adapter resolved dot segments (a URL) and uvicorn percent-decoded the path.
    const path = unquote(new URL(event.path, 'http://localhost').pathname);
    const reply = await server.handle(request, { path, clientIp: event.requestContext?.identity?.sourceIp ?? '',
      scheme: ['http', 'https', 'ws', 'wss'].includes(forwarded) ? forwarded : 'http' });
    const binary = binaryBody(reply.headers);
    const bytes = method === 'HEAD' ? new Uint8Array() : reply.body;
    return { statusCode: reply.status, headers: reply.headers, isBase64Encoded: binary && bytes.length > 0,
      body: Buffer.from(bytes).toString(binary ? 'base64' : 'utf8') };
  };
}

// Lambda Web Adapter's rule: a body with Content-Encoding or a non-text type travels base64.
const TEXT = /^(text|application\/(json|javascript|xml|yaml))/;
const binaryBody = ({ 'content-encoding': encoding, 'content-type': type }) => !!encoding
  || (type !== undefined && !TEXT.test(type) && !/\+(xml|yaml|json)$/.test(type.trim().split(';')[0]));

export const handler = createHandler();
