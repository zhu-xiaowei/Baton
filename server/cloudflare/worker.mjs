// The hosted service's Worker: static files are served by Workers static assets without running this code
// (`/` aside); REST and /ws go to the caller's AccountObject, found from the credential itself (tokens
// `bt_<account>_…`, the deployment key → ACCOUNT_ID); public routes run here.
import { PUBLIC } from '../core/app.mjs';
import { TOKEN } from '../core/auth.mjs';
import { compareDigest } from '../core/util.mjs';
import { refuse, server, toResponse } from './ports.mjs';
import { createTable } from './store.mjs';

export { AccountObject, IndexObject } from './account.mjs';

// Public routes (recover, claim) may replace a token: its sockets close in its account's object; ids carry the account.
const remote = (env) => {
  const object = (account) => env.ACCOUNT.get(env.ACCOUNT.idFromName(account));
  const call = (id, method, data) => { const [account, socket] = id.split(':'); return object(account).sockets(method, [null, socket, data]); };
  return { query: async (account, role, device) => (await object(account).sockets('query', [null, role, device]))
    .map((record) => ({ ...record, connectionId: `${account}:${record.connectionId}` })),
  get: (id) => { const [account, socket] = id.split(':'); return object(account).sockets('get', [socket]); },
  post: (_, id, data) => call(id, 'post', data), deleteConnection: (_, id) => call(id, 'deleteConnection'), handleDisconnect: async () => {},
  disconnectRemovedBridge: (account, endpoint, device) => object(account).sockets('disconnectRemovedBridge', [account, endpoint, device]) };
};
let publicServer;

function accountOf(credential, env) {
  if (credential.startsWith('bt_')) return TOKEN.exec(credential)?.[1] ?? null;
  return env.API_KEY && env.ACCOUNT_ID && credential && compareDigest(credential, env.API_KEY) ? env.ACCOUNT_ID : null;
}

const notFound = () => new Response('Not Found', { status: 404 });

// Hosts: API_URL serves REST, /ws and the Bridge package; WEB_URL the web app (`/`; files come from static
// assets on every host); /install and /install.ps1 answer anywhere (the install domain). One host may be both.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const api = new URL(env.API_URL);
    const entries = (env.API_ENTRIES ?? '').split(',').filter(Boolean).map((entry) => new URL(entry).host); // the relay's hosts
    const [onApi, onWeb] = [url.host === api.host || entries.includes(url.host), url.host === new URL(env.WEB_URL).host];
    if (onApi && /^\/v1(\/|$)/.test(url.pathname)) url.pathname = url.pathname.slice(3) || '/';
    if (url.pathname === '/install.ps1') {
      url.pathname = '/install';
      url.searchParams.set('platform', 'windows');
    }
    const path = url.pathname;
    if (path === '/') return onWeb ? env.ASSETS.fetch(new Request(new URL('/index.html', url), request)) : notFound();
    if (path === '/bridge.tar.gz' && onApi) {
      const object = await env.FILES?.get('install/bridge.tar.gz');
      return object ? new Response(object.body, { headers: { 'content-type': 'application/gzip', etag: object.httpEtag, 'cache-control': 'no-cache' } })
        : notFound();
    }
    if (!(path === '/install' || (onApi && /^\/(api\/|auth\/|ws$)/.test(path)))) return notFound();

    const headers = new Headers(request.headers);
    headers.delete('x-baton-account');
    const { country = '', continent = '', longitude, asn = '' } = request.cf ?? {};
    headers.set('cf-ipcountry', country);
    headers.set('x-baton-edge', JSON.stringify({ country, continent, lon: Number(longitude), asn })); // where to place a new account
    headers.delete('accept-encoding'); // the edge compresses; core's gzip would be compressed again
    // Install scripts name the server from these: always the API host, whichever host was asked.
    headers.set('host', api.host);
    headers.set('x-forwarded-proto', 'https');
    url.host = api.host;
    // As API Gateway: the address that connected comes last, so only a caller holding ORIGIN_SECRET picks another one.
    const ip = request.headers.get('cf-connecting-ip') ?? '';
    const hops = (headers.get('x-forwarded-for') ?? '').split(',').map((hop) => hop.trim()).filter(Boolean);
    if (hops.at(-1) !== ip) headers.set('x-forwarded-for', [...hops, ip].join(', '));

    let account;
    if (path === '/ws') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket upgrade', { status: 426 });
      const credential = url.searchParams.get('apiKey') ?? '';
      account = accountOf(credential, env);
      if (!account) return credential.startsWith('bt_') ? new Response('Unauthorized', { status: 401 }) : refuse(4401, 'unauthorized');
    } else if (path.startsWith('/api/') && !PUBLIC.has(path)) {
      account = accountOf(headers.get('x-api-key') ?? '', env);
    }
    if (account) headers.set('x-baton-account', account);
    const forwarded = new Request(url, { method: request.method, headers, body: request.body, cf: request.cf }); // cf: usage points
    if (account) return env.ACCOUNT.get(env.ACCOUNT.idFromName(account)).fetch(forwarded);
    publicServer ||= server(env, { table: createTable(env), sockets: remote(env), rpcInfo: async () => null,
      place: (account, hint) => env.ACCOUNT.get(env.ACCOUNT.idFromName(account), hint ? { locationHint: hint } : {}).colo() });
    return toResponse(await publicServer.handle(forwarded, { path, clientIp: ip, scheme: 'https' }), request.method);
  },
};
