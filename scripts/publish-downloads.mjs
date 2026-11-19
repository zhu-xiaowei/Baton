#!/usr/bin/env node
// Publishes a GitHub Release's packages on dl.agentbaton.app (public R2 bucket baton-downloads, set up by home/deploy.mjs --downloads):
// <tag>/Baton.* never change and are cached for a year; the top-level Baton.* are the latest release and cached for 5 minutes.
//   node scripts/publish-downloads.mjs <tag>   env: CF_ACCOUNT_ID, CF_API_TOKEN
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
execFileSync('gh', ['release', 'download', tag, '-R', 'zhu-xiaowei/Baton', '-D', dir, ...Object.keys(TYPES).flatMap((e) => ['-p', `Baton.${e}`])], { stdio: 'inherit' });
for (const [ext, type] of Object.entries(TYPES)) {
  const name = `Baton.${ext}`;
  const bytes = fs.readFileSync(path.join(dir, name));
  for (const [key, cache] of [[`${tag}/${name}`, 'public, max-age=31536000, immutable'], [name, 'public, max-age=300']]) {
    await cf('PUT', `/accounts/${ACCOUNT}/r2/buckets/baton-downloads/objects/${key}`, bytes,
      { 'content-type': type, 'cache-control': cache, 'content-disposition': `attachment; filename="${name}"` });
    console.log(`https://dl.agentbaton.app/${key}  ${bytes.length} B`);
  }
}
await cf('POST', '/zones/387d3d961b05753a9bb536e6545f817b/purge_cache', { files: Object.keys(TYPES).map((e) => `https://dl.agentbaton.app/Baton.${e}`) });
fs.rmSync(dir, { recursive: true, force: true });
