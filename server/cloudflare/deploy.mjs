#!/usr/bin/env node
// Development deploy of the hosted service through the Cloudflare API (no wrangler). Idempotent.
//   node server/cloudflare/deploy.mjs --name pr2-baton --bucket pr2-baton-files --api-domain api.agentbaton.app \
//     [--web-domain web.agentbaton.app] [--install-domain agentbaton.app] [--zone <zone id>] [--secrets <json file>]
//     [--relay] [--skip-build] [--rate-limit] [--max-apps 20] [--max-bridges 5]
// One Worker on every domain: the API host serves REST, /ws and the Bridge package; the web host the web app (default:
// the API host); on the install domain only the routes /install and /install.ps1 (the scripts always name the API host), the
// rest of that host stays someone else's (the homepage).
// env: CF_ACCOUNT_ID, CF_API_TOKEN. --secrets: { API_KEY, API_KEY_NAME, ORIGIN_SECRET?, R2_API_TOKEN?, R2_PARENT_KEY_ID? }.
// --rate-limit adds the zone's rate-limiting rule for the API host. --max-apps / --max-bridges: sockets per account (defaults in ports.mjs).
// --relay first deploys push-relay/worker.mjs as <name>-push with the APNs key read from stdin (the relay's SSM JSON).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const { values: flags } = parseArgs({ options: { name: { type: 'string', default: 'pr2-baton' }, bucket: { type: 'string', default: 'pr2-baton-files' },
  'api-domain': { type: 'string' }, 'web-domain': { type: 'string' }, 'install-domain': { type: 'string' }, zone: { type: 'string', default: '387d3d961b05753a9bb536e6545f817b' }, secrets: { type: 'string' },
  relay: { type: 'boolean', default: false }, 'skip-build': { type: 'boolean', default: false }, 'rate-limit': { type: 'boolean', default: false },
  'max-apps': { type: 'string' }, 'max-bridges': { type: 'string' } } });
const { CF_ACCOUNT_ID: ACCOUNT, CF_API_TOKEN: TOKEN } = process.env;
if (!ACCOUNT || !TOKEN) throw new Error('CF_ACCOUNT_ID and CF_API_TOKEN are required');
const API_HOST = flags['api-domain'];
const WEB_HOST = flags['web-domain'] ?? API_HOST;
const INSTALL_HOST = flags['install-domain'];
const domains = [...new Set([API_HOST, WEB_HOST])];
if (!API_HOST || [...domains, INSTALL_HOST ?? 'x.y'].some((d) => !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d))) throw new Error('--api-domain (and valid hostnames) required');
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;
const DATE = '2026-04-07';
const RELAY = `${flags.name}-push`;
// Tokens travel in WebSocket URL queries: logs must never record them.
const OBSERVABILITY = { enabled: true, redact_query_string: true, logs: { enabled: true, invocation_logs: false, persist: true, head_sampling_rate: 1 } };
const sh = (cmd, args, opts = {}) => (execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts }) ?? '').trim();

async function cf(method, route, body, { auth = TOKEN, ok404 = false } = {}) {
  const form = body instanceof FormData;
  const res = await fetch(route.startsWith('https:') ? route : API + route, { method, headers: { authorization: `Bearer ${auth}`,
    ...(body && !form && typeof body !== 'string' ? { 'content-type': 'application/json' } : {}) },
  body: body && !form && typeof body !== 'string' && !(body instanceof Uint8Array) ? JSON.stringify(body) : body });
  if (ok404 && res.status === 404) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) throw new Error(`${method} ${route}: ${res.status} ${JSON.stringify(json.errors ?? json).slice(0, 400)}`);
  return json.result;
}

const exists = async (name) => !!(await cf('GET', `/workers/scripts/${name}/settings`, undefined, { ok404: true }));
const module = (form, name, file) => form.append(name, new Blob([fs.readFileSync(path.join(ROOT, file))], { type: 'application/javascript+module' }), name);

// A new script is created with its migrations (PUT); later code goes up as a version that is then deployed and checked,
// because a plain re-upload can silently leave the previous version live.
async function upload(name, metadata, modules, migrations) {
  const form = () => {
    const f = new FormData();
    for (const [file, as] of modules) module(f, as, file);
    return f;
  };
  let version;
  if (!(await exists(name))) {
    const f = form();
    f.append('metadata', new Blob([JSON.stringify({ ...metadata, migrations })], { type: 'application/json' }));
    await cf('PUT', `/workers/scripts/${name}`, f);
  } else {
    const f = form();
    f.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    version = (await cf('POST', `/workers/scripts/${name}/versions`, f)).id;
    await cf('POST', `/workers/scripts/${name}/deployments`, { strategy: 'percentage', versions: [{ version_id: version, percentage: 100 }] });
  }
  // Cloudflare can answer with the previous state for a few seconds (seen right after creating a Worker).
  for (let attempt = 1; ; attempt++) {
    const live = (await cf('GET', `/workers/scripts/${name}/deployments`)).deployments[0]?.versions ?? [];
    version ??= live[0]?.version_id; // a new script's first version
    if (live.length === 1 && live[0].version_id === version && live[0].percentage === 100) break;
    if (attempt === 6) throw new Error(`${name}: version ${version} is not live`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  await cf('POST', `/workers/scripts/${name}/subdomain`, { enabled: false, previews_enabled: false });
  console.log(`${name}: version ${version} live`);
}

async function deployRelay() {
  const key = fs.readFileSync(0, 'utf8').trim();
  if (!key) throw new Error('--relay needs the APNs key on stdin');
  await upload(RELAY, { main_module: 'worker.mjs', compatibility_date: DATE, observability: OBSERVABILITY,
    bindings: [{ type: 'durable_object_namespace', name: 'APNS_TOKEN', class_name: 'ApnsToken' }, { type: 'secret_text', name: 'APNS_KEY', text: key }] },
  [['push-relay/worker.mjs', 'worker.mjs']], { new_tag: 'v1', new_sqlite_classes: ['ApnsToken'] });
}

// Routes need a proxied record; a placeholder one if the host has none yet.
async function installRoutes() {
  const zone = `https://api.cloudflare.com/client/v4/zones/${flags.zone}`;
  if (!(await cf('GET', `${zone}/dns_records?name=${INSTALL_HOST}`)).length) {
    await cf('POST', `${zone}/dns_records`, { type: 'AAAA', name: INSTALL_HOST, content: '100::', proxied: true });
  }
  const routes = await cf('GET', `${zone}/workers/routes`);
  for (const pattern of [`${INSTALL_HOST}/install`, `${INSTALL_HOST}/install.ps1`]) {
    const route = routes.find((r) => r.pattern === pattern);
    if (!route) await cf('POST', `${zone}/workers/routes`, { pattern, script: flags.name });
    else if (route.script !== flags.name) await cf('PUT', `${zone}/workers/routes/${route.id}`, { pattern, script: flags.name });
  }
}

// One rule for the API host (the Free plan allows one per zone): over 200 requests in 10 s from one IP → 429 for 10 s.
// WebSocket frames are no requests; only upgrades count.
async function rateLimit() {
  const zone = `https://api.cloudflare.com/client/v4/zones/${flags.zone}/rulesets`;
  const ref = `baton_${API_HOST.replace(/\W/g, '_')}`;
  const rule = { ref, description: `Baton API ${API_HOST}`, expression: `(http.host eq "${API_HOST}")`, action: 'block',
    action_parameters: { response: { status_code: 429, content_type: 'application/json', content: '{"error":"rate_limited"}' } },
    ratelimit: { characteristics: ['cf.colo.id', 'ip.src'], period: 10, requests_per_period: 200, mitigation_timeout: 10 } };
  const entry = await cf('GET', `${zone}/phases/http_ratelimit/entrypoint`, undefined, { ok404: true });
  const old = entry?.rules?.find((r) => r.ref === ref);
  if (!entry) await cf('PUT', `${zone}/phases/http_ratelimit/entrypoint`, { rules: [rule] });
  else if (old) await cf('PATCH', `${zone}/${entry.id}/rules/${old.id}`, rule);
  else await cf('POST', `${zone}/${entry.id}/rules`, rule);
  console.log(`rate limit: ${API_HOST}`);
}

async function bucket() {
  if (!(await cf('GET', `/r2/buckets/${flags.bucket}`, undefined, { ok404: true }))) await cf('POST', '/r2/buckets', { name: flags.bucket });
  await cf('PUT', `/r2/buckets/${flags.bucket}/cors`, { rules: [{ allowed: { origins: ['*'], methods: ['GET', 'PUT', 'HEAD'], headers: ['*'] },
    exposeHeaders: ['ETag', 'Content-Length', 'Content-Type', 'x-amz-checksum-sha256', 'x-amz-meta-filename', 'x-amz-meta-content-type',
      'x-amz-meta-sealed'], maxAgeSeconds: 3600 }] });
  await cf('PUT', `/r2/buckets/${flags.bucket}/lifecycle`, { rules: [{ id: 'transfers-1-day', enabled: true, conditions: { prefix: 't/' },
    deleteObjectsTransition: { condition: { type: 'Age', maxAge: 86400 } } }] });
}

// As server/install.sh builds it.
async function bridgePackage(version) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-bridge-'));
  try {
    for (const file of fs.readdirSync(path.join(ROOT, 'bridge'))) {
      if (file.endsWith('.mjs') || file === 'package.json' || file === 'package-lock.json') fs.copyFileSync(path.join(ROOT, 'bridge', file), path.join(stage, file));
    }
    fs.cpSync(path.join(ROOT, 'bridge/project'), path.join(stage, 'project'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'project-files.mjs'), fs.readFileSync(path.join(ROOT, 'bridge/project/files.mjs'), 'utf8')
      .replaceAll("from '../", "from './").replaceAll("from './ws-frames.mjs'", "from './project/ws-frames.mjs'"));
    fs.writeFileSync(path.join(stage, 'version.mjs'), `// Generated by server/install.sh\nexport const BRIDGE_VERSION = '${version}';\n`);
    const files = fs.readdirSync(stage).filter((f) => f.endsWith('.mjs'));
    sh('tar', ['czf', path.join(stage, 'bridge.tar.gz'), ...files, 'project', 'package.json', 'package-lock.json'], { cwd: stage });
    await cf('PUT', `/r2/buckets/${flags.bucket}/objects/install/bridge.tar.gz`, new Uint8Array(fs.readFileSync(path.join(stage, 'bridge.tar.gz'))));
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

// Workers static assets: every file with its own MIME type, `_headers` as #191's cache rules.
const MIME = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', svg: 'image/svg+xml', json: 'application/json', webmanifest: 'application/manifest+json', png: 'image/png',
  ico: 'image/vnd.microsoft.icon', wasm: 'application/wasm', woff2: 'font/woff2', webp: 'image/webp', jpg: 'image/jpeg', gif: 'image/gif',
  txt: 'text/plain; charset=utf-8', map: 'application/json' };
// HTML may be read from any origin: a native App learns the API server of a link's page from its <meta name="baton-api">.
const HEADERS = '/*\n  ! Cache-Control\n/*.html\n  Cache-Control: no-cache\n  Access-Control-Allow-Origin: *\n/assets/*.js\n  Cache-Control: public, max-age=31536000, immutable\n'
  + '/assets/*.css\n  Cache-Control: public, max-age=31536000, immutable\n';

async function assets(name) {
  const dist = path.join(ROOT, 'dist');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const files = {};
  const manifest = {};
  for (const file of walk(dist)) {
    let bytes = fs.readFileSync(file);
    // The web app's default server, when it is not the page's own origin.
    if (file.endsWith('.html') && WEB_HOST !== API_HOST) {
      bytes = Buffer.from(bytes.toString('utf8').replaceAll('<meta name="baton-api" content="">', `<meta name="baton-api" content="https://${API_HOST}">`));
    }
    const b64 = bytes.toString('base64');
    const hash = createHash('sha256').update(b64 + path.extname(file).slice(1)).digest('hex').slice(0, 32);
    files[hash] = { b64, type: MIME[path.extname(file).slice(1)] ?? 'application/octet-stream' };
    manifest[`/${path.relative(dist, file).split(path.sep).join('/')}`] = { hash, size: bytes.length };
  }
  const session = await cf('POST', `/workers/scripts/${name}/assets-upload-session`, { manifest });
  let jwt = session.jwt;
  for (const group of session.buckets ?? []) {
    const form = new FormData();
    for (const hash of group) form.append(hash, new Blob([files[hash].b64], { type: files[hash].type }), hash);
    jwt = (await cf('POST', '/workers/assets/upload?base64=true', form, { auth: jwt }))?.jwt ?? jwt;
  }
  console.log(`assets: ${Object.keys(manifest).length} files, ${(session.buckets ?? []).flat().length} uploaded`);
  return { jwt, config: { html_handling: 'none', not_found_handling: 'none', _headers: HEADERS } };
}

const secrets = flags.secrets ? JSON.parse(fs.readFileSync(flags.secrets, 'utf8')) : {};
const semantic = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const version = `${semantic}-${sh('git', ['rev-parse', '--short', 'HEAD'])}${sh('git', ['status', '--porcelain']) ? `-${Date.now().toString(36)}` : ''}`;

if (flags.relay) await deployRelay();
if (!flags['skip-build']) sh('npm', ['run', 'build'], { stdio: 'inherit' });
await bucket();
await bridgePackage(version);
const accountId = secrets.API_KEY ? createHash('sha256').update(secrets.API_KEY).digest('hex').slice(0, 16) : '';
const vars = { API_URL: `https://${API_HOST}`, WEB_URL: `https://${WEB_HOST}`, APP_VERSION: version, BRIDGE_VERSION: version, OPEN_REGISTRATION: 'true',
  CF_ACCOUNT_ID: ACCOUNT, R2_BUCKET: flags.bucket, ACCOUNT_ID: secrets.ACCOUNT_ID ?? accountId, API_KEY_NAME: secrets.API_KEY_NAME ?? '',
  R2_PARENT_KEY_ID: secrets.R2_PARENT_KEY_ID ?? '', MAX_APPS: flags['max-apps'], MAX_BRIDGES: flags['max-bridges'], ...(INSTALL_HOST && { INSTALL_URL: `https://${INSTALL_HOST}` }) };
const bindings = [{ type: 'assets', name: 'ASSETS' }, { type: 'r2_bucket', name: 'FILES', bucket_name: flags.bucket },
  { type: 'durable_object_namespace', name: 'ACCOUNT', class_name: 'AccountObject' },
  { type: 'durable_object_namespace', name: 'INDEX', class_name: 'IndexObject' },
  ...((await exists(RELAY)) ? [{ type: 'service', name: 'PUSH', service: RELAY }] : []),
  ...Object.entries(vars).filter(([, v]) => v).map(([name, text]) => ({ type: 'plain_text', name, text })),
  ...['API_KEY', 'ORIGIN_SECRET', 'R2_API_TOKEN'].filter((n) => secrets[n]).map((name) => ({ type: 'secret_text', name, text: secrets[name] }))];
const modules = [...fs.readdirSync(path.join(ROOT, 'server/core')).filter((f) => f.endsWith('.mjs')).map((f) => `server/core/${f}`),
  ...['worker', 'account', 'store', 'ports', 'r2'].map((f) => `server/cloudflare/${f}.mjs`)].map((f) => [f, f]);
await upload(flags.name, { main_module: 'server/cloudflare/worker.mjs', compatibility_date: DATE, bindings, assets: await assets(flags.name),
  observability: OBSERVABILITY }, modules, { new_tag: 'v1', new_sqlite_classes: ['AccountObject', 'IndexObject'] });
for (const hostname of domains) await cf('PUT', '/workers/domains', { hostname, service: flags.name, zone_id: flags.zone, environment: 'production' });
if (INSTALL_HOST) await installRoutes();
if (flags['rate-limit']) await rateLimit();
console.log(`deployed ${[...domains, ...(INSTALL_HOST ? [`${INSTALL_HOST}/install(.ps1)`] : [])].join(', ')} (version ${version}${bindings.some((b) => b.name === 'PUSH') ? ', push relay bound' : ''})`);
