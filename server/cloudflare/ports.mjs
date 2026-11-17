// What server/core needs on Cloudflare, shared by the Worker (public routes) and AccountObject (everything
// authenticated): core's env from Worker variables, the deployment key, the Bridge package, the push relay.
import { createServer } from '../core/app.mjs';
import { createAuth } from '../core/auth.mjs';
import { createDevices } from '../core/devices.mjs';
import { createNotifications } from '../core/notifications.mjs';

export const MAX_FRAME_BYTES = 1048576;
const NO_BODY = new Set([101, 204, 205, 304]);
const envs = new WeakMap();

export function coreEnv(env) {
  if (!envs.has(env)) {
    envs.set(env, { OPEN_REGISTRATION: env.OPEN_REGISTRATION, WEB_URL: env.WEB_URL, API_URL: env.API_URL, INSTALL_URL: env.INSTALL_URL, APP_VERSION: env.APP_VERSION,
      BRIDGE_VERSION: env.BRIDGE_VERSION, ACCOUNT_ID: env.ACCOUNT_ID, API_KEY_NAME: env.API_KEY_NAME, ORIGIN_SECRET: env.ORIGIN_SECRET,
      WS_API_ENDPOINT: `${env.API_URL}/ws`, CONNECTIONS_TABLE: 'relay', PUSH_RELAY_URL: env.PUSH ? 'https://push/' : '',
      NOTIFICATION_FEED: 'off', TOKENS_BY_ACCOUNT: '1' });
  }
  return envs.get(env);
}

// The push relay Worker over its service binding: same body and reply as the Lambda relay.
async function relayPost(env, body, timeoutSec) {
  const reply = await env.PUSH.fetch('https://push/', { method: 'POST', headers: { 'content-type': 'application/json' }, body,
    signal: AbortSignal.timeout(Math.max(1, timeoutSec * 1000)) });
  return { status: reply.status, data: await reply.text() };
}

// ports: table, sockets, rpcInfo (the caller's).
// Also core's auth, device rows and notifications, for sockets and alerts.
export function server(env, ports) {
  const all = { env: coreEnv(env), log: console.log, currentKey: async () => env.API_KEY ?? '',
    presign: async () => (env.FILES ? `${env.API_URL}/bridge.tar.gz` : null),
    relayPost: (url, body, timeoutSec) => relayPost(env, body, timeoutSec), ...ports };
  return { ...createServer(all), auth: createAuth(all), devices: createDevices(all.table), notifications: createNotifications(all) };
}

export const toResponse = (out, method) => new Response(method === 'HEAD' || NO_BODY.has(out.status) ? null : out.body,
  { status: out.status, headers: out.headers });

// Accepted, then closed: browsers and Node cannot read an upgrade's status (4401 bad credential, 4403 wrong role).
export function refuse(code, reason = '') {
  const [client, socket] = Object.values(new WebSocketPair());
  socket.accept();
  socket.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
}
