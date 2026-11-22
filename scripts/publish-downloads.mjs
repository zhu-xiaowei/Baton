#!/usr/bin/env node
// Publishes a GitHub Release's packages on dl.agentbaton.app (public R2 bucket baton-downloads, set up by home/deploy.mjs --downloads):
// One copy each (Baton.apk, .dmg, .exe, .deb): the edge keeps them for a year and is purged here, browsers for 5 minutes.
//   node scripts/publish-downloads.mjs <tag>   env: CF_ACCOUNT_ID, CF_API_TOKEN (R2 edit + zone cache purge)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tag = process.argv[2];
const { CF_ACCOUNT_ID: ACCOUNT, CF_API_TOKEN: TOKEN } = process.env;
if (!tag || !ACCOUNT || !TOKEN) throw new Error('usage: node scripts/publish-downloads.mjs <tag>   (env CF_ACCOUNT_ID, CF_API_TOKEN)');
const API = 'https://api.cloudflare.com/client/v4';
const TYPES = { apk: 'application/vnd.android.package-archive', dmg: 'application/x-apple-diskimage',
  exe: 'application/vnd.microsoft.portable-executable', deb: 'application/vnd.debian.binary-package' };

async function cf(method, route, body, headers = { 'content-type': 'application/json' }) {
  const res = await fetch(API + route, { method, headers: { authorization: `Bearer ${TOKEN}`, ...headers },
    body: headers['content-type'] === 'application/json' ? JSON.stringify(body) : body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) throw new Error(`${method} ${route}: ${res.status} ${JSON.stringify(json.errors ?? json).slice(0, 300)}`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-dl-'));
execFileSync('gh', ['release', 'download', tag, '-R', 'agentbaton/baton', '-D', dir, ...Object.keys(TYPES).flatMap((e) => ['-p', `Baton.${e}`])], { stdio: 'inherit' });
// All four are read before anything is written, so a missing asset never leaves a half-updated "latest".
const files = Object.entries(TYPES).map(([ext, type]) => [`Baton.${ext}`, type, fs.readFileSync(path.join(dir, `Baton.${ext}`))]);
// The whole host is purged, also after a failed upload, so no URL (with any query string) keeps an old package.
try {
  for (const [name, type, bytes] of files) {
    await cf('PUT', `/accounts/${ACCOUNT}/r2/buckets/baton-downloads/objects/${name}`, bytes,
      { 'content-type': type, 'cache-control': 'public, max-age=300', 'content-disposition': `attachment; filename="${name}"` });
  }
} finally {
  await cf('POST', '/zones/387d3d961b05753a9bb536e6545f817b/purge_cache', { hosts: ['dl.agentbaton.app'] });
}
for (const [name, , bytes] of files) console.log(`https://dl.agentbaton.app/${name}  ${bytes.length} B`);
fs.rmSync(dir, { recursive: true, force: true });
