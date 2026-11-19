#!/usr/bin/env node
// Publishes the homepage (this folder) as an assets-only Worker on agentbaton.app/* (no code runs per request).
// The more specific agentbaton.app/install(.ps1) routes keep going to the service Worker; www redirects to the apex.
//   node home/deploy.mjs [--name baton-home] [--host agentbaton.app] [--zone <zone id>]   env: CF_ACCOUNT_ID, CF_API_TOKEN
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values: f } = parseArgs({ options: { name: { type: 'string', default: 'baton-home' }, host: { type: 'string', default: 'agentbaton.app' },
  zone: { type: 'string', default: '387d3d961b05753a9bb536e6545f817b' } } });
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

// Assets: every .html file under this folder; / and /privacy/ resolve through auto-trailing-slash.
const files = {};
const manifest = {};
for (const rel of fs.readdirSync(DIR, { recursive: true }).filter((p) => p.endsWith('.html'))) {
  const b64 = fs.readFileSync(path.join(DIR, rel)).toString('base64');
  const hash = createHash('sha256').update(b64 + 'html').digest('hex').slice(0, 32);
  files[hash] = b64;
  manifest[`/${rel.split(path.sep).join('/')}`] = { hash, size: Buffer.from(b64, 'base64').length };
}
const session = await cf('POST', `${API}/accounts/${ACCOUNT}/workers/scripts/${f.name}/assets-upload-session`, { manifest });
let jwt = session.jwt;
for (const group of session.buckets ?? []) {
  const form = new FormData();
  for (const hash of group) form.append(hash, new Blob([files[hash]], { type: 'text/html; charset=utf-8' }), hash);
  jwt = (await cf('POST', `${API}/accounts/${ACCOUNT}/workers/assets/upload?base64=true`, form, jwt))?.jwt ?? jwt;
}
const metadata = { compatibility_date: '2026-04-07', assets: { jwt, config: { html_handling: 'auto-trailing-slash', not_found_handling: 'none',
  _headers: '/*\n  Cache-Control: no-cache\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n' } } };
const meta = new FormData();
meta.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
await cf('PUT', `${API}/accounts/${ACCOUNT}/workers/scripts/${f.name}`, meta);
await cf('POST', `${API}/accounts/${ACCOUNT}/workers/scripts/${f.name}/subdomain`, { enabled: false, previews_enabled: false });
console.log(`${f.name}: ${Object.keys(manifest).length} files, ${(session.buckets ?? []).flat().length} uploaded`);

// Routes need proxied records; the apex one already carries the install routes.
const www = `www.${f.host}`;
for (const name of [f.host, www]) {
  if (!(await cf('GET', `${ZONE}/dns_records?name=${name}`)).length) await cf('POST', `${ZONE}/dns_records`, { type: 'AAAA', name, content: '100::', proxied: true });
}
const pattern = `${f.host}/*`;
const route = (await cf('GET', `${ZONE}/workers/routes`)).find((r) => r.pattern === pattern);
if (!route) await cf('POST', `${ZONE}/workers/routes`, { pattern, script: f.name });
else if (route.script !== f.name) await cf('PUT', `${ZONE}/workers/routes/${route.id}`, { pattern, script: f.name });

// www → apex, path and query kept: the zone's single redirect rule set holds only this rule.
await cf('PUT', `${ZONE}/rulesets/phases/http_request_dynamic_redirect/entrypoint`, { rules: [{ description: `${www} to ${f.host}`,
  expression: `(http.host eq "${www}")`, action: 'redirect', action_parameters: { from_value: { status_code: 301, preserve_query_string: true,
    target_url: { expression: `concat("https://${f.host}", http.request.uri.path)` } } } }] });
console.log(`deployed https://${f.host}/ (route ${pattern}), ${www} redirects`);
