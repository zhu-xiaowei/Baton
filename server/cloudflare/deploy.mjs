#!/usr/bin/env node
// Development deploy of the hosted service through the Cloudflare API (no wrangler). Idempotent.
//   node server/cloudflare/deploy.mjs --name pr2-baton --bucket pr2-baton-files --api-domain api.agentbaton.app \
//     [--web-domain web.agentbaton.app] [--install-domain agentbaton.app] [--zone <zone id>] [--secrets <json file>]
//     [--relay] [--skip-build] [--rate-limit] [--max-apps 20] [--max-bridges 5] [--relay-domain <host> --relay-ips <ip,...>] [--zero-rtt]
// One Worker on every domain: the API host serves REST, /ws and the Bridge package; the web host the web app (default:
// the API host); on the install domain only the routes /install and /install.ps1 (the scripts always name the API host), the
// rest of that host stays someone else's (the homepage).
// env: CF_ACCOUNT_ID, CF_API_TOKEN. --secrets: { API_KEY, API_KEY_NAME, ORIGIN_SECRET?, R2_API_TOKEN?, R2_PARENT_KEY_ID? }.
// --rate-limit adds the zone's rate-limiting rule for the API host. --relay-domain: the mainland-China relay's host (docs/v2-cn-relay.md),
// a DNS-only record per --relay-ips address, answered only from those. --zero-rtt turns on the zone's TLS 0-RTT. --max-apps / --max-bridges: sockets per account (defaults in ports.mjs).
// --relay first deploys push-relay/worker.mjs as <name>-push with the APNs key read from stdin (the relay's SSM JSON).
// --monitor <host> --admin-email <address> [--monitor-name] [--cost-cap 1] [--cost-alert 20] [--plan free|paid] deploys only the monitor of the
// service <name> (server/cloudflare/monitor.mjs) behind Cloudflare Access; env MONITOR_API_TOKEN: a read-only token with
// Account Analytics Read + zone Analytics Read, stored as the secret ANALYTICS_TOKEN (optional: kept when unset, or added
// later in the dashboard; without it the monitor only probes). env RELAY_REPORT_KEY: the key relays report with (setup.sh REPORT_KEY),
// on <monitor>-report.<zone>, which is outside Access (kept when unset).
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const { values: flags } = parseArgs({ options: { name: { type: 'string', default: 'pr2-baton' }, bucket: { type: 'string', default: 'pr2-baton-files' },
  'api-domain': { type: 'string' }, 'web-domain': { type: 'string' }, 'install-domain': { type: 'string' }, zone: { type: 'string', default: '387d3d961b05753a9bb536e6545f817b' }, secrets: { type: 'string' },
  relay: { type: 'boolean', default: false }, 'skip-build': { type: 'boolean', default: false }, 'rate-limit': { type: 'boolean', default: false },
  'max-apps': { type: 'string' }, 'max-bridges': { type: 'string' }, 'usage-dataset': { type: 'string' }, monitor: { type: 'string' },
  'monitor-name': { type: 'string' }, 'admin-email': { type: 'string' }, 'cost-cap': { type: 'string', default: '1' },
  'cost-alert': { type: 'string', default: '20' }, plan: { type: 'string', default: 'free' }, 'relay-domain': { type: 'string' },
  'relay-ips': { type: 'string', default: '' }, 'zero-rtt': { type: 'boolean', default: false } } });
const { CF_ACCOUNT_ID: ACCOUNT, CF_API_TOKEN: TOKEN } = process.env;
if (!ACCOUNT || !TOKEN) throw new Error('CF_ACCOUNT_ID and CF_API_TOKEN are required');
const API_HOST = flags['api-domain'];
const WEB_HOST = flags['web-domain'] ?? API_HOST;
const INSTALL_HOST = flags['install-domain'];
const RELAY_HOST = flags['relay-domain'];
const RELAY_IPS = flags['relay-ips'].split(',').filter(Boolean);
if (RELAY_HOST && !RELAY_IPS.length) throw new Error('--relay-domain needs --relay-ips');
const domains = [...new Set([API_HOST, WEB_HOST])];
if (!API_HOST || [...domains, INSTALL_HOST ?? 'x.y'].some((d) => !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d))) throw new Error('--api-domain (and valid hostnames) required');
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;
const DATE = '2026-04-07';
const RELAY = `${flags.name}-push`;
// Usage points (Workers Analytics Engine, enabled once in the dashboard); --usage-dataset '' deploys without them.
const DATASET = flags['usage-dataset'] ?? `${flags.name.replaceAll('-', '_')}_usage`;
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
const module = (form, name, file) => form.append(name, new Blob([fs.readFileSync(path.join(ROOT, file))],
  { type: file.endsWith('.html') ? 'text/plain' : 'application/javascript+module' }), name);

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
  await routes([`${INSTALL_HOST}/install`, `${INSTALL_HOST}/install.ps1`]);
}

// IP_TOKEN_KEY signs the relay's address tokens: the file's, else the live one (inherit), else a new one.
async function ipTokenKey() {
  if (secrets.IP_TOKEN_KEY) return { type: 'secret_text', name: 'IP_TOKEN_KEY', text: secrets.IP_TOKEN_KEY };
  const live = (await cf('GET', `/workers/scripts/${flags.name}/settings`, undefined, { ok404: true }))?.bindings ?? [];
  return live.some((b) => b.name === 'IP_TOKEN_KEY') ? { type: 'inherit', name: 'IP_TOKEN_KEY' }
    : { type: 'secret_text', name: 'IP_TOKEN_KEY', text: randomBytes(32).toString('base64url') };
}

async function routes(patterns) {
  const zone = `https://api.cloudflare.com/client/v4/zones/${flags.zone}`;
  const existing = await cf('GET', `${zone}/workers/routes`);
  for (const pattern of patterns) {
    const route = existing.find((r) => r.pattern === pattern);
    if (!route) await cf('POST', `${zone}/workers/routes`, { pattern, script: flags.name });
    else if (route.script !== flags.name) await cf('PUT', `${zone}/workers/routes/${route.id}`, { pattern, script: flags.name });
  }
}

// DNS-only records point the host at the relays, which pass TLS through unopened; a custom rule refuses everyone else, so
// the relay's address is the only way in (the rate-limiting rule cannot exempt an address on the Free plan, and covers api only).
async function relayDomain() {
  const zone = `https://api.cloudflare.com/client/v4/zones/${flags.zone}`;
  const want = RELAY_IPS.map((ip) => ({ type: ip.includes(':') ? 'AAAA' : 'A', content: ip }));
  const have = await cf('GET', `${zone}/dns_records?name=${RELAY_HOST}`);
  const same = (a, b) => a.type === b.type && a.content === b.content && !a.proxied;
  for (const r of have) if (!want.some((w) => same(r, w))) await cf('DELETE', `${zone}/dns_records/${r.id}`);
  for (const w of want) if (!have.some((r) => same(r, w))) await cf('POST', `${zone}/dns_records`, { ...w, name: RELAY_HOST, ttl: 300, proxied: false });
  await routes([`${RELAY_HOST}/*`]);
  await zoneRule('http_request_firewall_custom', { ref: `baton_${RELAY_HOST.replace(/\W/g, '_')}`, description: `Baton relay entry ${RELAY_HOST}`,
    expression: `(http.host eq "${RELAY_HOST}" and not ip.src in {${RELAY_IPS.join(' ')}})`, action: 'block' });
  console.log(`relay domain: ${RELAY_HOST} -> ${RELAY_IPS.join(', ')}`);
}

// One rule for the API host (the Free plan allows one per zone): over 200 requests in 10 s from one IP → 429 for 10 s.
// WebSocket frames are no requests; only upgrades count.
async function rateLimit() {
  await zoneRule('http_ratelimit', { ref: `baton_${API_HOST.replace(/\W/g, '_')}`, description: `Baton API ${API_HOST}`,
    expression: `(http.host eq "${API_HOST}")`, action: 'block',
    action_parameters: { response: { status_code: 429, content_type: 'application/json', content: '{"error":"rate_limited"}' } },
    ratelimit: { characteristics: ['cf.colo.id', 'ip.src'], period: 10, requests_per_period: 200, mitigation_timeout: 10 } });
  console.log(`rate limit: ${API_HOST}`);
}

// Adds or updates the rule with this ref in the zone's entrypoint ruleset of a phase.
async function zoneRule(phase, rule) {
  const zone = `https://api.cloudflare.com/client/v4/zones/${flags.zone}/rulesets`;
  const entry = await cf('GET', `${zone}/phases/${phase}/entrypoint`, undefined, { ok404: true });
  const old = entry?.rules?.find((r) => r.ref === rule.ref);
  if (!entry) await cf('PUT', `${zone}/phases/${phase}/entrypoint`, { rules: [rule] });
  else if (old) await cf('PATCH', `${zone}/${entry.id}/rules/${old.id}`, rule);
  else await cf('POST', `${zone}/${entry.id}/rules`, rule);
}

async function bucket() {
  if (!(await cf('GET', `/r2/buckets/${flags.bucket}`, undefined, { ok404: true }))) await cf('POST', '/r2/buckets', { name: flags.bucket });
  await cf('PUT', `/r2/buckets/${flags.bucket}/cors`, { rules: [{ allowed: { origins: ['*'], methods: ['GET', 'PUT', 'HEAD', 'POST', 'DELETE'], headers: ['*'] },
    exposeHeaders: ['ETag', 'Content-Length', 'Content-Type', 'x-amz-checksum-sha256', 'x-amz-meta-filename', 'x-amz-meta-content-type',
      'x-amz-meta-sealed'], maxAgeSeconds: 3600 }] });
  // Transfer objects live an hour (reused for 30 min, bridge/transfer-store.mjs); unfinished multipart uploads a day.
  await cf('PUT', `/r2/buckets/${flags.bucket}/lifecycle`, { rules: [{ id: 'transfers-1-hour', enabled: true, conditions: { prefix: 't/' },
    deleteObjectsTransition: { condition: { type: 'Age', maxAge: 3600 } },
    abortMultipartUploadsTransition: { condition: { type: 'Age', maxAge: 86400 } } }] });
}

// As server/install.sh builds it. Its version is the last commit that changed bridge/, not this deploy's: a deploy that
// leaves the Bridge unchanged must not make every Bridge restart (they update when they see another version).
async function bridgePackage() {
  const semantic = JSON.parse(fs.readFileSync(path.join(ROOT, 'bridge/package.json'), 'utf8')).version;
  const dirty = sh('git', ['status', '--porcelain', '--', 'bridge']) ? `-${Date.now().toString(36)}` : '';
  const version = `${semantic}-${sh('git', ['log', '-1', '--format=%h', '--', 'bridge'])}${dirty}`;
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
    return version;
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

// The monitor: probe account (registered once, its token a secret), Access app (email one-time PIN), Email Routing
// (alerts + support@ forwarding to --admin-email), the Worker with its 5-minute cron.
async function deployMonitor() {
  const name = flags['monitor-name'] ?? `${flags.name}-monitor`;
  const email = flags['admin-email'];
  if (!/^\S+@\S+\.\S+$/.test(email ?? '')) throw new Error('--admin-email is required');
  const zone = `https://api.cloudflare.com/client/v4/zones/${flags.zone}`;
  const zoneName = (await cf('GET', zone)).name;
  const namespaces = (await cf('GET', '/workers/durable_objects/namespaces?per_page=1000')).filter((n) => [flags.name, RELAY].includes(n.script));
  const accountNs = namespaces.find((n) => n.script === flags.name && n.class === 'AccountObject')?.id;
  if (!accountNs) throw new Error(`${flags.name} has no AccountObject namespace`);
  const old = (await exists(name)) ? Object.fromEntries((await cf('GET', `/workers/scripts/${name}/settings`)).bindings.map((b) => [b.name, b.text])) : {};
  const secrets = {};
  if (process.env.MONITOR_API_TOKEN) secrets.ANALYTICS_TOKEN = process.env.MONITOR_API_TOKEN;
  else if (!('ANALYTICS_TOKEN' in old)) console.log(`${name}: no ANALYTICS_TOKEN yet; add it as a secret (read-only analytics token) to start usage, cost and the cap`);
  if (process.env.RELAY_REPORT_KEY) secrets.RELAY_REPORT_KEY = process.env.RELAY_REPORT_KEY;
  else if (!('RELAY_REPORT_KEY' in old)) console.log(`${name}: no RELAY_REPORT_KEY; relays cannot report until it is set`);
  const reportHost = flags.monitor.replace(/^[^.]+/, (label) => `${label}-report`);
  let probe = old.PROBE_ACCOUNT;
  if (!probe || !('PROBE_TOKEN' in old)) {
    const { accountOf, recoveryOf } = await import('../../bridge/e2ee-node.mjs');
    const k = randomBytes(32);
    const id = accountOf(k);
    const res = await fetch(`https://${API_HOST}/api/account/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...id, ...recoveryOf(randomBytes(32), k), deviceName: 'monitor-probe' }) });
    if (!res.ok) throw new Error(`probe account: ${res.status} ${await res.text()}`);
    [probe, secrets.PROBE_TOKEN] = [id.accountId, (await res.json()).token];
  }
  // Access: the Zero Trust organization (once per Cloudflare account), one-time PIN login, the app allowing only --admin-email.
  let org = await cf('GET', '/access/organizations').catch(() => null);
  org ??= await cf('POST', '/access/organizations', { name: zoneName, auth_domain: `${zoneName.split('.')[0]}.cloudflareaccess.com` });
  const idps = await cf('GET', '/access/identity_providers');
  const otp = idps.find((i) => i.type === 'onetimepin') ?? await cf('POST', '/access/identity_providers', { name: 'One-time PIN', type: 'onetimepin', config: {} });
  const appBody = { name, domain: flags.monitor, type: 'self_hosted', session_duration: '730h', allowed_idps: [otp.id], auto_redirect_to_identity: true,
    policies: [{ name: 'admins', decision: 'allow', include: [{ email: { email } }] }] };
  const app = (await cf('GET', '/access/apps')).find((a) => a.domain === flags.monitor);
  const { aud } = app ? await cf('PUT', `/access/apps/${app.id}`, appBody) : await cf('POST', '/access/apps', appBody);
  // Email Routing: alerts may only go to a verified destination; the user clicks the link Cloudflare mails once.
  if (!(await cf('GET', `${zone}/email/routing`)).enabled) await cf('POST', `${zone}/email/routing/enable`, {});
  const address = (await cf('GET', '/email/routing/addresses')).find((a) => a.email === email) ?? await cf('POST', '/email/routing/addresses', { email });
  const support = `support@${zoneName}`;
  if (address.verified && !(await cf('GET', `${zone}/email/routing/rules`)).some((r) => r.matchers?.some((m) => m.value === support))) {
    await cf('POST', `${zone}/email/routing/rules`, { name: 'support', enabled: true, matchers: [{ type: 'literal', field: 'to', value: support }],
      actions: [{ type: 'forward', value: [email] }] });
  }
  // SCRIPTS: the service Worker (the relay's CPU is added separately; an unknown name would empty a scriptName_in query).
  const vars = { CF_ACCOUNT_ID: ACCOUNT, ZONE_ID: flags.zone, TARGET_API: `https://${API_HOST}`, SERVICE_SCRIPT: flags.name, PUSH_SCRIPT: RELAY,
    SCRIPTS: flags.name, ACCOUNT_NS: accountNs, NAMESPACES: namespaces.map((n) => n.id).join(','), BUCKET: flags.bucket,
    HOSTS: domains.join(','), DATASET, PROBE_ACCOUNT: probe, PROBE_HASH: createHash('sha256').update(probe).digest('hex').slice(0, 16),
    COST_CAP: flags['cost-cap'], COST_ALERT: flags['cost-alert'], PLAN: flags.plan === 'paid' ? 'paid' : 'free', ADMIN_EMAIL: email, FROM_EMAIL: `monitor@${zoneName}`,
    MONITOR_URL: `https://${flags.monitor}`, ACCESS_AUD: aud, ACCESS_TEAM: org.auth_domain, REPORT_HOST: reportHost };
  await upload(name, { main_module: 'server/cloudflare/monitor.mjs', compatibility_date: DATE, observability: OBSERVABILITY, keep_bindings: ['secret_text'],
    bindings: [{ type: 'durable_object_namespace', name: 'ACCOUNT', class_name: 'AccountObject', script_name: flags.name },
      { type: 'durable_object_namespace', name: 'STORE', class_name: 'MonitorStore' }, { type: 'send_email', name: 'EMAIL', destination_address: email },
      ...Object.entries(vars).filter(([, v]) => v).map(([n, text]) => ({ type: 'plain_text', name: n, text }))] },
  ['monitor.mjs', 'cost.mjs', 'monitor.html'].map((f) => [`server/cloudflare/${f}`, `server/cloudflare/${f}`]), { new_tag: 'v1', new_sqlite_classes: ['MonitorStore'] });
  for (const [n, text] of Object.entries(secrets)) await cf('PUT', `/workers/scripts/${name}/secrets`, { name: n, text, type: 'secret_text' });
  await cf('PUT', `/workers/scripts/${name}/schedules`, [{ cron: '*/5 * * * *' }]);
  for (const hostname of [flags.monitor, reportHost]) await cf('PUT', '/workers/domains', { hostname, service: name, zone_id: flags.zone, environment: 'production' });
  console.log(`monitor ${name} on https://${flags.monitor} (Access: ${email}); alerts to ${email}: ${address.verified ? 'verified'
    : 'NOT verified yet: click the link Cloudflare mailed to it'}; ${address.verified ? `${support} forwards there` : `rerun after verifying to forward ${support}`}`);
}

if (flags.monitor) {
  await deployMonitor();
  process.exit(0);
}

const secrets = flags.secrets ? JSON.parse(fs.readFileSync(flags.secrets, 'utf8')) : {};
const semantic = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const version = `${semantic}-${sh('git', ['rev-parse', '--short', 'HEAD'])}${sh('git', ['status', '--porcelain']) ? `-${Date.now().toString(36)}` : ''}`;

if (flags.relay) await deployRelay();
if (!flags['skip-build']) sh('npm', ['run', 'build'], { stdio: 'inherit' });
await bucket();
const bridgeVersion = await bridgePackage();
const accountId = secrets.API_KEY ? createHash('sha256').update(secrets.API_KEY).digest('hex').slice(0, 16) : '';
const vars = { API_URL: `https://${API_HOST}`, WEB_URL: `https://${WEB_HOST}`, APP_VERSION: version, BRIDGE_VERSION: bridgeVersion, OPEN_REGISTRATION: 'true',
  CF_ACCOUNT_ID: ACCOUNT, R2_BUCKET: flags.bucket, ACCOUNT_ID: secrets.ACCOUNT_ID ?? accountId, API_KEY_NAME: secrets.API_KEY_NAME ?? '',
  R2_PARENT_KEY_ID: secrets.R2_PARENT_KEY_ID ?? '', MAX_APPS: flags['max-apps'], MAX_BRIDGES: flags['max-bridges'], ...(INSTALL_HOST && { INSTALL_URL: `https://${INSTALL_HOST}` }),
  ...(RELAY_HOST && { API_ENTRIES: `https://${RELAY_HOST}`, RELAY_IPS: RELAY_IPS.join(',') }) };
const bindings = [{ type: 'assets', name: 'ASSETS' }, { type: 'r2_bucket', name: 'FILES', bucket_name: flags.bucket },
  { type: 'durable_object_namespace', name: 'ACCOUNT', class_name: 'AccountObject' },
  { type: 'durable_object_namespace', name: 'INDEX', class_name: 'IndexObject' },
  ...(DATASET ? [{ type: 'analytics_engine', name: 'USAGE', dataset: DATASET }] : []),
  ...((await exists(RELAY)) ? [{ type: 'service', name: 'PUSH', service: RELAY }] : []),
  ...Object.entries(vars).filter(([, v]) => v).map(([name, text]) => ({ type: 'plain_text', name, text })),
  ...['API_KEY', 'ORIGIN_SECRET', 'R2_API_TOKEN'].filter((n) => secrets[n]).map((name) => ({ type: 'secret_text', name, text: secrets[name] })),
  ...(RELAY_HOST ? [await ipTokenKey()] : [])];
const modules = [...fs.readdirSync(path.join(ROOT, 'server/core')).filter((f) => f.endsWith('.mjs')).map((f) => `server/core/${f}`),
  ...['worker', 'account', 'store', 'ports', 'r2', 'usage'].map((f) => `server/cloudflare/${f}.mjs`)].map((f) => [f, f]);
await upload(flags.name, { main_module: 'server/cloudflare/worker.mjs', compatibility_date: DATE, bindings, assets: await assets(flags.name),
  observability: OBSERVABILITY }, modules, { new_tag: 'v1', new_sqlite_classes: ['AccountObject', 'IndexObject'] });
for (const hostname of domains) await cf('PUT', '/workers/domains', { hostname, service: flags.name, zone_id: flags.zone, environment: 'production' });
if (INSTALL_HOST) await installRoutes();
if (flags['rate-limit']) await rateLimit();
if (RELAY_HOST) await relayDomain();
if (flags['zero-rtt']) await cf('PATCH', `https://api.cloudflare.com/client/v4/zones/${flags.zone}/settings/0rtt`, { value: 'on' });
console.log(`deployed ${[...domains, ...(INSTALL_HOST ? [`${INSTALL_HOST}/install(.ps1)`] : [])].join(', ')} (version ${version}${bindings.some((b) => b.name === 'PUSH') ? ', push relay bound' : ''})`);
