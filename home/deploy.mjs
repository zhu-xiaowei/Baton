#!/usr/bin/env node
// Publishes the homepage (this folder) as an assets-only Worker on agentbaton.app/* (no code runs per request).
// The more specific agentbaton.app/install(.ps1) routes keep going to the service Worker; www redirects to the apex.
//   node home/deploy.mjs [--name baton-home] [--host agentbaton.app] [--zone <zone id>]   env: CF_ACCOUNT_ID, CF_API_TOKEN
//   --downloads instead sets up dl.<host>: the public R2 bucket baton-downloads that scripts/publish-downloads.mjs fills.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values: f } = parseArgs({ options: { name: { type: 'string', default: 'baton-home' }, host: { type: 'string', default: 'agentbaton.app' },
  zone: { type: 'string', default: '387d3d961b05753a9bb536e6545f817b' }, downloads: { type: 'boolean', default: false } } });
const { CF_ACCOUNT_ID: ACCOUNT, CF_API_TOKEN: TOKEN } = process.env;
if (!ACCOUNT || !TOKEN) throw new Error('CF_ACCOUNT_ID and CF_API_TOKEN are required');
const API = 'https://api.cloudflare.com/client/v4';
const ZONE = `${API}/zones/${f.zone}`;
const DIR = path.dirname(new URL(import.meta.url).pathname);

async function cf(method, url, body, auth = TOKEN) {
  const form = body instanceof FormData;
  const res = await fetch(url, { method, headers: { authorization: `Bearer ${auth}`, ...(body && !form ? { 'content-type': 'application/json' } : {}) },
    body: body && !form ? JSON.stringify(body) : body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) throw new Error(`${method} ${url.replace(API, '')}: ${res.status} ${JSON.stringify(json.errors ?? json).slice(0, 300)}`);
  return json.result;
}

// Replaces only the rule with this ref in a zone phase; the zone's other rules are kept.
async function rule(phase, r) {
  const url = `${ZONE}/rulesets/phases/${phase}/entrypoint`;
  const current = await cf('GET', url).catch((e) => (/: 404 /.test(e.message) ? { rules: [] } : Promise.reject(e)));
  const keep = (current.rules ?? []).filter((x) => x.ref !== r.ref).map(({ ref, description, expression, action, action_parameters, enabled }) =>
    ({ ref, description, expression, action, action_parameters, enabled }));
  await cf('PUT', url, { rules: [...keep, r] });
}

if (f.downloads) {
  const dl = `dl.${f.host}`;
  const bucket = `${API}/accounts/${ACCOUNT}/r2/buckets/baton-downloads`;
  await cf('GET', bucket).catch((e) => (/: 404 /.test(e.message) ? cf('POST', `${API}/accounts/${ACCOUNT}/r2/buckets`, { name: 'baton-downloads' }) : Promise.reject(e)));
  if (!(await cf('GET', `${bucket}/domains/custom`)).domains.some((d) => d.domain === dl)) await cf('POST', `${bucket}/domains/custom`, { domain: dl, zoneId: f.zone, enabled: true });
  // The edge keeps files a year (publish-downloads.mjs purges them); browsers follow each object's short Cache-Control.
  await rule('http_request_cache_settings', { ref: 'dl-cache', description: `${dl} cache`, expression: `(http.host eq "${dl}")`, action: 'set_cache_settings',
    action_parameters: { cache: true, edge_ttl: { mode: 'override_origin', default: 31536000 }, browser_ttl: { mode: 'respect_origin' } } });
  console.log(`https://${dl}/ serves baton-downloads`);
  process.exit(0);
}

// Assets: every .html, .txt and .avif file under this folder; / and /privacy/ resolve through auto-trailing-slash.
const TYPES = { html: 'text/html; charset=utf-8', txt: 'text/plain; charset=utf-8', avif: 'image/avif' };
const files = {};
const manifest = {};
const types = {};
for (const rel of fs.readdirSync(DIR, { recursive: true }).filter((p) => TYPES[path.extname(p).slice(1)])) {
  const ext = path.extname(rel).slice(1);
  const bytes = fs.readFileSync(path.join(DIR, rel));
  const b64 = bytes.toString('base64');
  const hash = createHash('sha256').update(b64 + ext).digest('hex').slice(0, 32);
  files[hash] = b64;
  types[hash] = TYPES[ext];
  manifest[`/${rel.split(path.sep).join('/')}`] = { hash, size: bytes.length };
}
const session = await cf('POST', `${API}/accounts/${ACCOUNT}/workers/scripts/${f.name}/assets-upload-session`, { manifest });
let jwt = session.jwt;
for (const group of session.buckets ?? []) {
  const form = new FormData();
  for (const hash of group) form.append(hash, new Blob([files[hash]], { type: types[hash] }), hash);
  jwt = (await cf('POST', `${API}/accounts/${ACCOUNT}/workers/assets/upload?base64=true`, form, jwt))?.jwt ?? jwt;
}
const metadata = { compatibility_date: '2026-04-07', assets: { jwt, config: { html_handling: 'auto-trailing-slash', not_found_handling: 'none',
  _headers: '/*\n  Cache-Control: no-cache\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n' } } };
const meta = new FormData();
meta.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
await cf('PUT', `${API}/accounts/${ACCOUNT}/workers/scripts/${f.name}`, meta);
await cf('POST', `${API}/accounts/${ACCOUNT}/workers/scripts/${f.name}/subdomain`, { enabled: false, previews_enabled: false });
console.log(`${f.name}: ${Object.keys(manifest).length} files, ${(session.buckets ?? []).flat().length} uploaded`);

// Routes and the redirect need proxied records (an existing record is assumed proxied); the apex one already carries the install routes.
const www = `www.${f.host}`;
for (const name of [f.host, www]) {
  if (!(await cf('GET', `${ZONE}/dns_records?name=${name}`)).length) await cf('POST', `${ZONE}/dns_records`, { type: 'AAAA', name, content: '100::', proxied: true });
}
const pattern = `${f.host}/*`;
const route = (await cf('GET', `${ZONE}/workers/routes`)).find((r) => r.pattern === pattern);
if (!route) await cf('POST', `${ZONE}/workers/routes`, { pattern, script: f.name });
else if (route.script !== f.name) await cf('PUT', `${ZONE}/workers/routes/${route.id}`, { pattern, script: f.name });

// www → apex, path and query kept.
await rule('http_request_dynamic_redirect', { ref: 'home-www', description: `${www} to ${f.host}`, expression: `(http.host eq "${www}")`, action: 'redirect',
  action_parameters: { from_value: { status_code: 301, preserve_query_string: true, target_url: { expression: `concat("https://${f.host}", http.request.uri.path)` } } } });
console.log(`deployed https://${f.host}/ (route ${pattern}), ${www} redirects`);
