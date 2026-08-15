import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexWatcher } from '../../../bridge/codex-watcher.mjs';
import { storageSessionId } from '../../../bridge/session-identity.mjs';

function argument(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
  return value ? Number(value) : fallback;
}

if (!process.argv.includes('--run')) {
  console.log('Run with --run [--files=10000] [--updates=100]');
  process.exit(0);
}

const fileCount = argument('files', 10_000);
const updateCount = argument('updates', 100);
if (!Number.isInteger(fileCount) || fileCount < 1 || fileCount > 50_000) {
  throw new Error('files must be an integer between 1 and 50000');
}
if (!Number.isInteger(updateCount) || updateCount < 1 || updateCount > fileCount) {
  throw new Error('updates must be an integer between 1 and files');
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-parcel-stress-'));
const sessionsRoot = path.join(root, 'sessions');
fs.mkdirSync(sessionsRoot, { recursive: true });

const initialSessions = [];
const watermarks = new Map();
const recentSessions = new Set();
const statuses = new Map();
const files = [];
let watcher;

try {
  for (let index = 0; index < fileCount; index++) {
    const group = path.join(sessionsRoot, `g${String(Math.floor(index / 100)).padStart(3, '0')}`);
    if (index % 100 === 0) fs.mkdirSync(group, { recursive: true });
    const nativeSessionId = `019fe900-${index.toString(16).padStart(4, '0')}-7000-8000-${String(index).padStart(12, '0')}`;
    const filePath = path.join(
      group,
      `rollout-2026-08-10T00-00-00-${nativeSessionId}.jsonl`,
    );
    fs.writeFileSync(filePath, `${JSON.stringify({
      timestamp: '2026-08-01T00:00:00.000Z',
      type: 'session_meta',
      payload: { session_id: nativeSessionId, cwd: '/tmp/project' },
    })}\n`);
    files.push({ filePath, nativeSessionId });
    const sessionId = storageSessionId('codex', nativeSessionId);
    initialSessions.push({
      id: nativeSessionId,
      nativeSessionId,
      runtime: 'codex',
      project: '-tmp-project',
      lastActive: '2026-08-01T00:00:00.000Z',
      status: 'completed',
    });
    watermarks.set(sessionId, 1);
    recentSessions.add(sessionId);
    statuses.set(sessionId, 'completed');
  }

  const delivered = [];
  const rssBefore = process.memoryUsage().rss;
  const startedAt = performance.now();
  watcher = new CodexWatcher({ deviceName: 'Parcel-Stress' }, {
    codexHomes: [root],
    initialSessions,
    watermarks,
    recentSessions,
    lastKnownStatus: statuses,
    knownProjects: new Set(['-tmp-project']),
    deliverFn: async (_sessionId, messages) => delivered.push(...messages),
    postFn: async () => ({ ok: true }),
    reconcileFn: async () => {},
    runningInfoFn: () => ({ projects: new Set(), sessions: new Set() }),
    rescanMs: 3_600_000,
    statusRecheckMs: 3_600_000,
  });
  watcher.start();
  await watcher.readyPromise;
  const readyMs = performance.now() - startedAt;
  const rssAfter = process.memoryUsage().rss;

  let openFds = null;
  if (process.platform !== 'win32') {
    try {
      openFds = Number(execFileSync('/bin/sh', [
        '-lc',
        `lsof -p ${process.pid} | wc -l`,
      ], { encoding: 'utf8' }).trim());
    } catch {}
  }

  const targets = [];
  for (let index = 0; index < updateCount; index++) {
    targets.push(files[Math.floor(index * fileCount / updateCount)]);
  }
  const appendStartedAt = performance.now();
  for (const { filePath } of targets) {
    fs.appendFileSync(filePath, `${JSON.stringify({
      timestamp: '2026-08-10T02:20:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'stress update' }],
      },
    })}\n`);
  }

  const deadline = Date.now() + 15_000;
  while (delivered.length < updateCount && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const unique = new Set(delivered.map((message) => message.uuid)).size;
  const result = {
    platform: process.platform,
    arch: process.arch,
    files: fileCount,
    subscriptions: watcher.watchHandles.size,
    directFileWatchers: watcher.fileWatchers.size,
    readyMs: Number(readyMs.toFixed(1)),
    rssDeltaMiB: Number(((rssAfter - rssBefore) / 1048576).toFixed(1)),
    openFds,
    updated: updateCount,
    delivered: delivered.length,
    unique,
    eventMs: Number((performance.now() - appendStartedAt).toFixed(1)),
  };
  console.log(JSON.stringify(result));
  if (delivered.length !== updateCount
    || unique !== updateCount
    || watcher.watchHandles.size !== 1
    || watcher.fileWatchers.size > 64) {
    process.exitCode = 1;
  }
} finally {
  watcher?.stop();
  fs.rmSync(root, { recursive: true, force: true });
}
