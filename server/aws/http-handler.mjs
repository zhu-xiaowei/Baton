// The REST API Lambda: API Gateway proxy events in, the server's responses out.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signHeaders, signUrl } from '../../bridge/transfer-store.mjs';
import { createServer } from '../core/app.mjs';
import { createDevices } from '../core/devices.mjs';
import { currentKey } from './api-key.mjs';
import { credentials, region, request } from './aws.mjs';
import { rpcInfo } from './credentials.mjs';
import { createTable } from './dynamodb.mjs';
import { createSockets } from './sockets.mjs';
import { web } from './web-files.mjs';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

// On the kept-alive connection; one fresh retry if it was dropped while the Lambda was frozen.
export async function relayPost(url, body, timeoutSec) {
  const host = new URL(url).hostname.split('.');
  const signRegion = host.length > 2 && host[1] === 'lambda-url' ? host[2] : region();
  for (const fresh of [false, true]) {
    try {
      const headers = { 'content-type': 'application/json' };
      const signed = await signHeaders({ method: 'POST', url, region: signRegion, service: 'lambda', credentials: credentials(), headers, body });
      const reply = await request(url, { method: 'POST', headers: { ...headers, ...signed }, body, timeoutMs: timeoutSec * 1000 });
      return { status: reply.status, data: reply.text };
    } catch (error) {
      if (fresh) throw error;
    }
  }
}

// The Bridge package's download URL for install scripts (valid one hour).
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
    const headers = new Headers();
    for (const [name, value] of Object.entries(event.headers ?? {})) if (value !== null) headers.set(name, value);
    const query = new URLSearchParams();
    for (const [name, values] of Object.entries(event.multiValueQueryStringParameters ?? {})) for (const value of values ?? []) query.append(name, value);
    if (![...query].length) for (const [name, value] of Object.entries(event.queryStringParameters ?? {})) query.append(name, value);
    const body = event.body === null || event.body === undefined ? undefined : Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
    const method = event.httpMethod;
    const request = new Request(`http://localhost/?${query}`, { method, headers, body: ['GET', 'HEAD'].includes(method) ? undefined : body });
    // API Gateway passes the path as sent: dot segments resolved and percent-decoded here.
    let path = new URL(event.path, 'http://localhost').pathname;
    try {
      path = decodeURIComponent(path);
    } catch {}
    const reply = await server.handle(request, { path, clientIp: event.requestContext?.identity?.sourceIp ?? '' });
    const binary = !/^(text\/|application\/json|image\/svg\+xml)/.test(reply.headers['content-type'] ?? 'text/');
    const bytes = method === 'HEAD' ? new Uint8Array() : reply.body;
    return { statusCode: reply.status, headers: reply.headers, isBase64Encoded: binary && bytes.length > 0,
      body: Buffer.from(bytes).toString(binary ? 'base64' : 'utf8') };
  };
}

export const handler = createHandler();
