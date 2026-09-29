#!/usr/bin/env node
// Trigger the Xcode Cloud workflow that archives iOS and ships it to TestFlight, then wait for the result.
//
// Works on any OS (used from Linux hosts without Xcode). Prerequisites:
//   - .env.local: APPSTORE_KEY_ID, APPSTORE_ISSUER_ID (optional XCODE_CLOUD_WORKFLOW, default "Default")
//   - ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8
//   - The current commit is pushed to the repository Xcode Cloud is connected to.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const BUNDLE_ID = 'com.batonai.app';
const POLL_MS = 30_000;
const TIMEOUT_MS = 90 * 60_000;

function loadEnv() {
  const file = path.join(ROOT, '.env.local');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

loadEnv();
const KEY_ID = process.env.APPSTORE_KEY_ID;
const ISSUER_ID = process.env.APPSTORE_ISSUER_ID;
const WORKFLOW_NAME = process.env.XCODE_CLOUD_WORKFLOW || 'Default';
if (!KEY_ID || !ISSUER_ID) die('Set APPSTORE_KEY_ID and APPSTORE_ISSUER_ID in .env.local');
const KEY_PATH = path.join(os.homedir(), '.appstoreconnect/private_keys', `AuthKey_${KEY_ID}.p8`);
if (!fs.existsSync(KEY_PATH)) die(`Missing App Store Connect key: ${KEY_PATH}`);
const PRIVATE_KEY = fs.readFileSync(KEY_PATH);

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function token() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' })}.${b64({ iss: ISSUER_ID, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' })}`;
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: PRIVATE_KEY, dsaEncoding: 'ieee-p1363' });
  return `${unsigned}.${sig.toString('base64url')}`;
}

async function api(method, urlPath, body) {
  const res = await fetch(`https://api.appstoreconnect.apple.com${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) die(`${method} ${urlPath} -> ${res.status} ${JSON.stringify(json?.errors ?? json)}`);
  return json;
}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
const head = git('rev-parse', 'HEAD');
if (git('status', '--porcelain', '--untracked-files=no')) console.warn('WARNING: uncommitted changes are not part of the cloud build');

const apps = await api('GET', `/v1/apps?filter[bundleId]=${BUNDLE_ID}&fields[apps]=name`);
const appId = apps.data[0]?.id ?? die(`No App Store Connect app for ${BUNDLE_ID}`);
const product = (await api('GET', `/v1/apps/${appId}/ciProduct?include=primaryRepositories`)).data;
const repoId = product.relationships.primaryRepositories.data[0]?.id ?? die('Xcode Cloud product has no repository');
const repo = (await api('GET', `/v1/scmRepositories/${repoId}`)).data.attributes;

const remoteSha = git('ls-remote', repo.httpCloneUrl, `refs/heads/${branch}`).split(/\s+/)[0];
if (remoteSha !== head) die(`${repo.httpCloneUrl} ${branch} is at ${remoteSha || '(missing)'}, local HEAD is ${head}; push first`);

const workflows = await api('GET', `/v1/ciProducts/${product.id}/workflows?fields[ciWorkflows]=name`);
const workflow = workflows.data.find((w) => w.attributes.name === WORKFLOW_NAME) ?? die(`No Xcode Cloud workflow named "${WORKFLOW_NAME}"`);
const refs = await api('GET', `/v1/scmRepositories/${repoId}/gitReferences?limit=200&fields[scmGitReferences]=name,kind`);
const ref = refs.data.find((r) => r.attributes.kind === 'BRANCH' && r.attributes.name === branch) ?? die(`Xcode Cloud does not see branch ${branch}`);

console.log(`==> Starting Xcode Cloud "${WORKFLOW_NAME}" on ${repo.ownerName}/${repo.repositoryName}@${branch} (${head.slice(0, 7)})`);
const run = (await api('POST', '/v1/ciBuildRuns', {
  data: {
    type: 'ciBuildRuns',
    relationships: {
      workflow: { data: { type: 'ciWorkflows', id: workflow.id } },
      sourceBranchOrTag: { data: { type: 'scmGitReferences', id: ref.id } },
    },
  },
})).data;
console.log(`==> Build run #${run.attributes.number} (${run.id})`);

const started = Date.now();
let last = '';
let attrs;
for (;;) {
  attrs = (await api('GET', `/v1/ciBuildRuns/${run.id}?fields[ciBuildRuns]=executionProgress,completionStatus`)).data.attributes;
  const state = attrs.completionStatus ? `${attrs.executionProgress}/${attrs.completionStatus}` : attrs.executionProgress;
  if (state !== last) console.log(`    ${new Date().toISOString().slice(11, 19)} ${state}`);
  last = state;
  if (attrs.executionProgress === 'COMPLETE') break;
  if (Date.now() - started > TIMEOUT_MS) die(`timed out after ${TIMEOUT_MS / 60_000} min; run ${run.id} is still ${state}`);
  await sleep(POLL_MS);
}

const actions = await api('GET', `/v1/ciBuildRuns/${run.id}/actions?fields[ciBuildActions]=name,completionStatus`);
for (const action of actions.data) {
  console.log(`==> ${action.attributes.name}: ${action.attributes.completionStatus}`);
  if (action.attributes.completionStatus === 'SUCCEEDED') continue;
  const issues = await api('GET', `/v1/ciBuildActions/${action.id}/issues?limit=50`);
  for (const { attributes: i } of issues.data) {
    const where = i.fileSource ? ` (${i.fileSource.path}:${i.fileSource.lineNumber})` : '';
    console.log(`    [${i.issueType}] ${i.message}${where}`);
  }
}
if (attrs.completionStatus !== 'SUCCEEDED') die(`Xcode Cloud build #${run.attributes.number} ${attrs.completionStatus}`);

const builds = await api('GET', `/v1/ciBuildRuns/${run.id}/builds?fields[builds]=version,processingState`);
for (const { attributes: b } of builds.data) console.log(`==> App Store Connect build ${b.version} (${b.processingState})`);
console.log('==> Done. TestFlight build will be available after processing (~5-15 minutes).');
console.log('    https://appstoreconnect.apple.com/apps -> Baton -> TestFlight');
