#!/usr/bin/env node
// Bump the configured iOS build number, trigger Xcode Cloud, and wait for TestFlight.
//
// Works on any OS (used from Linux hosts without Xcode). Prerequisites:
//   - .env.local: APPSTORE_KEY_ID, APPSTORE_ISSUER_ID (optional XCODE_CLOUD_WORKFLOW, default "Default")
//   - ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8
//   - The current commit is pushed to the repository Xcode Cloud is connected to.
//   - Xcode Cloud's Next Build Number matches the version printed by --dry-run.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const BUNDLE_ID = 'com.batonai.app';
const PROJECT_YML = 'src-tauri/gen/apple/project.yml';
const INFO_PLIST = 'src-tauri/gen/apple/baton_iOS/Info.plist';
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

async function allPages(urlPath) {
  const data = [];
  const included = [];
  while (urlPath) {
    const page = await api('GET', urlPath);
    data.push(...page.data);
    included.push(...(page.included ?? []));
    const next = page.links?.next;
    const nextUrl = next ? new URL(next, 'https://api.appstoreconnect.apple.com') : null;
    urlPath = nextUrl ? `${nextUrl.pathname}${nextUrl.search}` : null;
  }
  return { data, included };
}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dryRun = process.argv.slice(2).includes('--dry-run');
if (process.argv.slice(2).some((arg) => arg !== '--dry-run')) die('Usage: node scripts/release-ios-cloud.mjs [--dry-run]');

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
const head = git('rev-parse', 'HEAD');
if (branch === 'HEAD') die('Check out a branch before releasing');
if (!dryRun && git('status', '--porcelain', '--untracked-files=no')) die('Commit or discard tracked changes before releasing');

const projectPath = path.join(ROOT, PROJECT_YML);
const plistPath = path.join(ROOT, INFO_PLIST);
const project = fs.readFileSync(projectPath, 'utf8');
const plist = fs.readFileSync(plistPath, 'utf8');
const marketingVersion = project.match(/^\s*CFBundleShortVersionString: (\d+\.\d+\.\d+)\s*$/m)?.[1];
const plistMarketingVersion = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>(\d+\.\d+\.\d+)<\/string>/)?.[1];
const projectBuild = project.match(/^\s*CFBundleVersion: "(\d+)"\s*$/m)?.[1];
const plistBuild = plist.match(/<key>CFBundleVersion<\/key>\s*<string>(\d+)<\/string>/)?.[1];
if (!marketingVersion || marketingVersion !== plistMarketingVersion || !projectBuild || projectBuild !== plistBuild) die(`${PROJECT_YML} and ${INFO_PLIST} must have the same marketing version and numeric build number`);
const configuredBuild = Number(projectBuild);
if (!Number.isSafeInteger(configuredBuild)) die('Configured build number is too large');
if (JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri/tauri.conf.json'), 'utf8')).version !== marketingVersion) die('Tauri and Xcode marketing versions differ');

const apps = await api('GET', `/v1/apps?filter[bundleId]=${BUNDLE_ID}&fields[apps]=name`);
const appId = apps.data[0]?.id ?? die(`No App Store Connect app for ${BUNDLE_ID}`);
const product = (await api('GET', `/v1/apps/${appId}/ciProduct`)).data;
const repos = await api('GET', `/v1/ciProducts/${product.id}/primaryRepositories`);
const repoId = repos.data[0]?.id ?? die('Xcode Cloud product has no repository');
const repo = repos.data[0].attributes;

const remoteSha = git('ls-remote', repo.httpCloneUrl, `refs/heads/${branch}`).split(/\s+/)[0];
if (remoteSha !== head) die(`${repo.httpCloneUrl} ${branch} is at ${remoteSha || '(missing)'}, local HEAD is ${head}; push first`);

// Release branches do not need to be merged, so the source build number can
// lag behind uploads. Failed Cloud runs also consume build numbers.
const builds = await allPages(`/v1/builds?filter[app]=${appId}&limit=200&include=preReleaseVersion&fields[builds]=version,preReleaseVersion&fields[preReleaseVersions]=version`);
const versionById = new Map((builds.included ?? []).map((v) => [v.id, v.attributes.version]));
const uploadedBuild = Math.max(0, ...builds.data
  .filter((b) => versionById.get(b.relationships?.preReleaseVersion?.data?.id) === marketingVersion)
  .map((b) => Number(b.attributes.version)));
if (!Number.isSafeInteger(uploadedBuild)) die(`App Store Connect returned an invalid build number for ${marketingVersion}`);

const versionCommit = git('blame', '--porcelain', '-L', '/CFBundleVersion:/,+1', '--', PROJECT_YML).split(/\s+/)[0];
const versionCommitted = !/^0+$/.test(versionCommit);
const preparedByScript = versionCommitted && git('show', '-s', '--format=%s', versionCommit) === `chore(ios): bump build number to ${configuredBuild}`;
const priorRuns = await allPages(`/v1/ciProducts/${product.id}/buildRuns?limit=200`);
const lastCloudBuild = Math.max(0, ...priorRuns.data.map((r) => Number(r.attributes.number)));
if (!Number.isSafeInteger(lastCloudBuild)) die('Xcode Cloud returned an invalid build number');
const versionWasRun = priorRuns.data.some((r) => {
  const sha = r.attributes.sourceCommit?.commitSha;
  if (!sha || !versionCommitted) return false;
  try { git('merge-base', '--is-ancestor', versionCommit, sha); return true; }
  catch { return false; }
});
let releaseHead = head;
const needsBump = configuredBuild <= Math.max(uploadedBuild, lastCloudBuild) || versionWasRun || !preparedByScript;
const releaseBuild = needsBump ? Math.max(configuredBuild, uploadedBuild, lastCloudBuild) + 1 : configuredBuild;
if (!Number.isSafeInteger(releaseBuild)) die('Next build number is too large');
if (dryRun) {
  console.log(`Configured: ${marketingVersion} (${configuredBuild}); latest uploaded: ${marketingVersion} (${uploadedBuild})`);
  console.log(`Next release: ${marketingVersion} (${releaseBuild})${needsBump ? ' (bump both Xcode files)' : ' (reuse prepared version)'}`);
  console.log(`Last Xcode Cloud run: #${lastCloudBuild}`);
  process.exit(0);
}
if (needsBump) {
  fs.writeFileSync(projectPath, project.replace(/^(\s*CFBundleVersion: ")\d+("\s*)$/m, (_, before, after) => `${before}${releaseBuild}${after}`));
  fs.writeFileSync(plistPath, plist.replace(/(<key>CFBundleVersion<\/key>\s*<string>)\d+(<\/string>)/, (_, before, after) => `${before}${releaseBuild}${after}`));
  git('add', '--', PROJECT_YML, INFO_PLIST);
  git('commit', '-m', `chore(ios): bump build number to ${releaseBuild}`);
  releaseHead = git('rev-parse', 'HEAD');
  console.log(`==> Prepared ${marketingVersion} (${releaseBuild}) in ${releaseHead.slice(0, 7)}`);
  git('push', repo.httpCloneUrl, `HEAD:refs/heads/${branch}`);
} else {
  console.log(`==> Reusing prepared ${marketingVersion} (${releaseBuild}) in ${releaseHead.slice(0, 7)}`);
}

const workflows = await api('GET', `/v1/ciProducts/${product.id}/workflows?fields[ciWorkflows]=name`);
const workflow = workflows.data.find((w) => w.attributes.name === WORKFLOW_NAME) ?? die(`No Xcode Cloud workflow named "${WORKFLOW_NAME}"`);
const refs = await api('GET', `/v1/scmRepositories/${repoId}/gitReferences?limit=200&fields[scmGitReferences]=name,kind`);
const ref = refs.data.find((r) => r.attributes.kind === 'BRANCH' && r.attributes.name === branch) ?? die(`Xcode Cloud does not see branch ${branch}`);

console.log(`==> Starting Xcode Cloud "${WORKFLOW_NAME}" on ${repo.ownerName}/${repo.repositoryName}@${branch} (${releaseHead.slice(0, 7)})`);
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
if (Number(run.attributes.number) !== releaseBuild) {
  console.error(`ERROR: Xcode Cloud assigned build #${run.attributes.number}, but the configured version is ${releaseBuild}. The CI pre-build check will stop this archive.`);
  console.error(`Set Xcode Cloud > Settings > Build Number > Next Build Number to ${releaseBuild} in App Store Connect, then retry.`);
}

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

if (Number(run.attributes.number) !== releaseBuild) die(`Cloud build number did not match configured build ${releaseBuild}`);

let processedBuild;
const processingStarted = Date.now();
for (;;) {
  const builds = await api('GET', `/v1/ciBuildRuns/${run.id}/builds?fields[builds]=version,processingState`);
  if (builds.data.some((b) => Number(b.attributes.version) !== releaseBuild)) die(`Uploaded build number did not match configured build ${releaseBuild}`);
  processedBuild = builds.data.find((b) => Number(b.attributes.version) === releaseBuild);
  if (processedBuild?.attributes.processingState === 'VALID') break;
  if (processedBuild && processedBuild.attributes.processingState !== 'PROCESSING') die(`App Store Connect build ${releaseBuild} is ${processedBuild.attributes.processingState}`);
  if (Date.now() - processingStarted > 30 * 60_000) die(`timed out waiting for App Store Connect build ${releaseBuild} to process`);
  await sleep(POLL_MS);
}
console.log(`==> App Store Connect build ${releaseBuild}: VALID (${processedBuild.id})`);

// Xcode Cloud builds must be assigned to internal TestFlight groups explicitly.
const groups = await api('GET', `/v1/apps/${appId}/betaGroups?limit=200`);
const group = groups.data.find((g) => g.attributes.isInternalGroup && g.attributes.name === 'Test') ?? die('No internal TestFlight group named "Test"');
const groupBuilds = await api('GET', `/v1/betaGroups/${group.id}/builds?limit=200&fields[builds]=version`);
if (!groupBuilds.data.some((b) => b.id === processedBuild.id)) {
  await api('POST', `/v1/builds/${processedBuild.id}/relationships/betaGroups`, {
    data: [{ type: 'betaGroups', id: group.id }],
  });
}
let internalState;
for (let attempt = 0; attempt < 6; attempt++) {
  const beta = await api('GET', `/v1/builds/${processedBuild.id}/buildBetaDetail`);
  internalState = beta.data.attributes.internalBuildState;
  if (internalState === 'IN_BETA_TESTING') break;
  await sleep(5_000);
}
if (internalState !== 'IN_BETA_TESTING') die(`Internal TestFlight state is ${internalState}`);
console.log('==> Done. Internal TestFlight group "Test": IN_BETA_TESTING.');
