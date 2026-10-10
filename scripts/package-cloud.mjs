#!/usr/bin/env node
// Run the native GitHub Actions packaging workflow from a Linux checkout.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = process.env.PACKAGE_GITHUB_REPO || 'zhu-xiaowei/Baton';
const workflow = 'package.yml';
const releaseTargets = [
  { platform: 'android', label: 'Android', artifact: 'Baton-Android', file: 'Baton.apk', job: 'Android APK' },
  { platform: 'macos', label: 'macOS', artifact: 'Baton-macOS', file: 'Baton.dmg', job: 'macOS notarized DMG' },
  { platform: 'windows', label: 'Windows', artifact: 'Baton-Windows', file: 'Baton.exe', job: 'Windows NSIS' },
];
const testTargets = [
  { platform: 'android', label: 'Android', artifact: 'Baton-test-Android', file: 'Baton.apk', job: 'Android APK' },
  { platform: 'ios', label: 'iOS', artifact: 'Baton-test-iOS', file: 'Baton.ipa', job: 'iOS unsigned IPA' },
  { platform: 'macos', label: 'macOS', artifact: 'Baton-test-macOS', file: 'Baton.dmg', job: 'macOS test DMG' },
  { platform: 'windows', label: 'Windows', artifact: 'Baton-test-Windows', file: 'Baton.exe', job: 'Windows NSIS' },
];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function die(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function command(program, args) {
  return execFileSync(program, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function gh(args) {
  return command('gh', [...args, '--repo', repo]);
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let size = bytes;
  let unit = -1;
  do { size /= 1024; unit++; } while (size >= 1024 && unit < units.length - 1);
  return `${size.toFixed(1)} ${units[unit]}`;
}

const args = process.argv.slice(2);
const usage = 'Usage: node scripts/package-cloud.mjs [--test] [--platform android|ios|macos|windows|all] [--dry-run]';
let dryRun = false;
let testMode = false;
let platform = 'all';
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--dry-run' && !dryRun) dryRun = true;
  else if (arg === '--test' && !testMode) testMode = true;
  else if (arg === '--platform' && platform === 'all' && args[index + 1]) platform = args[++index];
  else die(usage);
}
if (!['all', 'android', 'ios', 'macos', 'windows'].includes(platform)) die(usage);
const targets = (testMode ? testTargets : releaseTargets).filter((target) =>
  platform === 'all' || target.platform === platform);
if (!targets.length) die(`No release package for ${platform}; use --test for an unsigned iOS IPA`);
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) die(`Invalid PACKAGE_GITHUB_REPO: ${repo}`);

const branch = command('git', ['branch', '--show-current']);
if (!branch) die('Check out a branch before packaging');
if (command('git', ['status', '--porcelain', '--untracked-files=normal'])) {
  die('Commit or discard worktree changes before cloud packaging; the workflow can only build pushed source');
}
const sha = command('git', ['rev-parse', 'HEAD']);
const remoteSha = command('git', ['ls-remote', `https://github.com/${repo}.git`, `refs/heads/${branch}`]).split(/\s+/)[0];
if (sha !== remoteSha) {
  die(`${repo}@${branch} is at ${remoteSha || '(missing)'}, local HEAD is ${sha}; push this commit before packaging`);
}

const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const tauriVersion = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8')).version;
if (version !== tauriVersion) die(`package.json version ${version} differs from Tauri version ${tauriVersion}`);
const destination = testMode
  ? path.join(root, 'release', 'test', sha.slice(0, 12))
  : path.join(root, 'release', version);

if (!testMode) {
  const neededSecrets = [
    ...(targets.some((target) => target.platform === 'android')
      ? ['ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_PASSWORD'] : []),
    ...(targets.some((target) => target.platform === 'macos')
      ? ['MACOS_CERTIFICATE_P12_BASE64', 'MACOS_CERTIFICATE_PASSWORD', 'APPSTORE_PRIVATE_KEY_BASE64'] : []),
  ];
  const neededVariables = targets.some((target) => target.platform === 'macos')
    ? ['APPLE_SIGNING_IDENTITY', 'APPSTORE_KEY_ID', 'APPSTORE_ISSUER_ID'] : [];
  const availableSecrets = new Set(JSON.parse(gh(['secret', 'list', '--json', 'name'])).map((item) => item.name));
  const availableVariables = new Set(JSON.parse(gh(['variable', 'list', '--json', 'name'])).map((item) => item.name));
  const missingSecrets = neededSecrets.filter((name) => !availableSecrets.has(name));
  const missingVariables = neededVariables.filter((name) => !availableVariables.has(name));
  if (missingSecrets.length) console.warn(`Missing GitHub Actions secrets: ${missingSecrets.join(', ')}`);
  if (missingVariables.length) console.warn(`Missing GitHub Actions variables: ${missingVariables.join(', ')}`);
  if (missingSecrets.length || missingVariables.length) {
    console.warn('Affected platforms will fail; see docs/package.md for setup.');
  }
}
console.log(`==> Packaging Baton ${testMode ? 'test' : `v${version}`} ${platform} from ${repo}@${branch} (${sha.slice(0, 7)})`);
if (dryRun) {
  console.log('Dry run: source and version checked; no workflow started.');
  process.exit(0);
}

const requestId = crypto.randomUUID();
const dispatch = ['workflow', 'run', workflow, '--ref', branch,
  '-f', `expected_sha=${sha}`, '-f', `request_id=${requestId}`];
if (testMode || platform !== 'all') dispatch.push('-f', `mode=${testMode ? 'test' : 'release'}`, '-f', `platform=${platform}`);
gh(dispatch);
console.log(`==> Dispatched ${workflow} (${requestId})`);

let run;
for (let attempt = 0; attempt < 24; attempt++) {
  const runs = JSON.parse(gh([
    'run', 'list', '--workflow', workflow, '--event', 'workflow_dispatch',
    '--branch', branch, '--limit', '50', '--json', 'databaseId,displayTitle,headSha',
  ]));
  run = runs.find((candidate) => candidate.displayTitle.includes(requestId));
  if (run) break;
  await sleep(5_000);
}
if (!run) die(`Dispatched ${requestId}, but GitHub did not list the run; inspect Actions before retrying`);
if (run.headSha !== sha) die(`Run ${run.databaseId} uses ${run.headSha}, expected ${sha}`);

let detail;
let lastStatus = '';
for (let attempt = 0; attempt < 480; attempt++) {
  detail = JSON.parse(gh(['run', 'view', String(run.databaseId), '--json', 'status,conclusion,headSha,url,jobs']));
  if (detail.headSha !== sha) die(`Run ${run.databaseId} changed source SHA`);
  const status = detail.status === 'completed' ? `${detail.status}/${detail.conclusion}` : detail.status;
  if (status !== lastStatus) console.log(`==> ${detail.url}: ${status}`);
  lastStatus = status;
  if (detail.status === 'completed') break;
  await sleep(15_000);
}
if (detail.status !== 'completed') die(`Timed out waiting for ${detail.url}; inspect this run before retrying`);

fs.mkdirSync(destination, { recursive: true });
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-package-'));
const results = [];
try {
  for (const target of targets) {
    const output = path.join(destination, target.file);
    fs.rmSync(output, { force: true });
    const job = detail.jobs?.find((candidate) => candidate.name === target.job);
    if (job?.conclusion !== 'success') {
      results.push(`${target.label}: BUILD FAILED (${job?.conclusion || 'job missing'})`);
      continue;
    }
    const extract = path.join(stage, target.artifact);
    fs.mkdirSync(extract);
    try {
      gh(['run', 'download', String(run.databaseId), '--name', target.artifact, '--dir', extract]);
      const source = path.join(extract, target.file);
      if (!fs.existsSync(source) || !fs.statSync(source).size) throw new Error(`${target.file} missing or empty`);
      fs.copyFileSync(source, output);
      results.push(`${target.label}: ${path.relative(root, output)} (${humanSize(fs.statSync(output).size)})`);
    } catch (error) {
      results.push(`${target.label}: artifact download failed (${error.message})`);
    }
  }
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}

console.log(`==================== SUMMARY (${testMode ? `test ${platform} at ${sha.slice(0, 7)}` : `v${version}`}) ====================`);
for (const result of results) console.log(`  - ${result}`);
if (results.some((result) => result.includes('FAILED') || result.includes('download failed'))) process.exitCode = 1;
