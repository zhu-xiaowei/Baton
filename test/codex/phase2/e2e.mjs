#!/usr/bin/env node
import { spawn } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { performance } from 'perf_hooks';
import readline from 'readline';
import { CodexWatcher } from '../../../bridge/codex-watcher.mjs';
import {
  discoverCodexSessions,
  findCodexSessionFile,
} from '../../../bridge/codex-session.mjs';
import { initHttp } from '../../../bridge/http.mjs';
import { resolveCodexBin } from '../../../bridge/runtime-capabilities.mjs';
import { projectHashFromCwd, storageSessionId } from '../../../bridge/session-identity.mjs';
import { initWs, wsSend } from '../../../bridge/ws.mjs';

if (!process.argv.includes('--run')) {
  console.error('Refusing to run live Codex/AWS validation without --run');
  process.exit(2);
}

const require = createRequire(new URL('../../../bridge/package.json', import.meta.url));
const WebSocket = require('ws');

function loadEnv(filePath) {
  const values = {};
  for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const split = trimmed.indexOf('=');
    if (split < 1) continue;
    const key = trimmed.slice(0, split);
    let value = trimmed.slice(split + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, timeoutMs, label, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function spawnCodex(binary, cwd, codexHome, prompt) {
  const child = spawn(binary, [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ignore-rules',
    '--sandbox',
    'workspace-write',
    '-C',
    cwd,
    prompt,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: codexHome },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });

  let resolveThread;
  let rejectThread;
  const thread = new Promise((resolve, reject) => {
    resolveThread = resolve;
    rejectThread = reject;
  });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    try {
      const event = JSON.parse(line);
      if (event.type === 'thread.started' && event.thread_id) resolveThread(event.thread_id);
    } catch {}
  });

  const done = new Promise((resolve, reject) => {
    child.on('error', (error) => {
      rejectThread(error);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else {
        const error = new Error(`codex exited code=${code} signal=${signal || ''}: ${stderr.trim()}`);
        rejectThread(error);
        reject(error);
      }
    });
  });
  return { thread, done };
}

function assistantText(payload) {
  return (payload.content || [])
    .filter((block) => block?.type === 'output_text')
    .map((block) => block.text || '')
    .join('\n');
}

async function observeRollout(codexHome, nativeSessionId, toolMarker, replyMarker) {
  const seen = {};
  await waitFor(() => {
    const filePath = findCodexSessionFile(nativeSessionId, { codexHomes: [codexHome] });
    if (!filePath) return false;
    let lines;
    try {
      lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    } catch {
      return false;
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const payload = entry.payload || {};
      if (!seen.tool && entry.type === 'response_item'
        && payload.type === 'function_call_output'
        && String(payload.output || '').includes(toolMarker)) {
        seen.tool = performance.now();
      }
      if (!seen.reply && entry.type === 'response_item'
        && payload.type === 'message'
        && payload.role === 'assistant'
        && assistantText(payload).includes(replyMarker)) {
        seen.reply = performance.now();
      }
    }
    return seen.tool && seen.reply ? seen : false;
  }, 90_000, `rollout markers for ${nativeSessionId}`, 15);
  return seen;
}

async function fetchJson(url, apiKey, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'x-api-key': apiKey,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${url} -> ${response.status}`);
  return response.json();
}

const env = loadEnv(path.join(process.cwd(), '.env.local'));
const server = String(env.BATON_API_URL || '').replace(/\/$/, '');
const apiKey = env.BATON_API_KEY || '';
if (!server || !apiKey) throw new Error('.env.local must define BATON_API_URL and BATON_API_KEY');
const serverConfig = await fetchJson(`${server}/api/bridge/config`, apiKey);
if (!serverConfig.wsUrl) throw new Error('Server did not return wsUrl');

const deviceName = 'Codex-E2E';
const config = { server, apiKey, wsUrl: serverConfig.wsUrl, deviceName };
const sourceCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-codex-home-'));
for (const name of ['config.toml', 'auth.json', 'installation_id', 'models_cache.json']) {
  const source = path.join(sourceCodexHome, name);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(codexHome, name));
}
const initial = discoverCodexSessions({ codexHomes: [codexHome] });
const watermarks = new Map();
const recent = new Set();
const statuses = new Map();
const projects = new Set();
for (const session of initial.sessions) {
  const sessionId = storageSessionId('codex', session.nativeSessionId);
  watermarks.set(sessionId, session._lineCount);
  recent.add(sessionId);
  statuses.set(sessionId, session.status);
  projects.add(session.project);
}

initHttp(config);
initWs(config);
await waitFor(() => wsSend({ action: 'heartbeat' }), 20_000, 'Bridge WebSocket connection', 100);
const watcher = new CodexWatcher(config, {
  codexHomes: [codexHome],
  initialSessions: initial.sessions,
  watermarks,
  recentSessions: recent,
  lastKnownStatus: statuses,
  knownProjects: projects,
}).start();

const app = new WebSocket(`${serverConfig.wsUrl}?apiKey=${apiKey}&role=app`);
await new Promise((resolve, reject) => {
  app.once('open', resolve);
  app.once('error', reject);
});
const received = [];
app.on('message', (data) => {
  const arrivedAt = performance.now();
  try {
    const payload = JSON.parse(data.toString());
    if (payload.action !== 'messages') return;
    for (const message of payload.messages || []) {
      received.push({ sessionId: payload.sessionId, message, arrivedAt });
    }
  } catch {}
});

const codexBin = resolveCodexBin();
if (!codexBin) throw new Error('Codex binary not found');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-codex-e2e-'));
const projectHash = projectHashFromCwd(cwd);
const runId = Date.now().toString(36);

async function runSession(index) {
  const toolMarker = `APEEK_E2E_TOOL_${runId}_${index}`;
  const replyMarker = `APEEK_E2E_REPLY_${runId}_${index}`;
  const prompt = [
    `Execute exactly this shell command: sleep 3; printf '${toolMarker}\\n'.`,
    `After the command completes, reply exactly ${replyMarker} and nothing else.`,
  ].join(' ');
  const processRun = spawnCodex(codexBin, cwd, codexHome, prompt);
  const nativeSessionId = await waitFor(
    () => Promise.race([processRun.thread, delay(25).then(() => null)]),
    20_000,
    `Codex thread ${index}`,
  );
  const sessionId = storageSessionId('codex', nativeSessionId);
  app.send(JSON.stringify({ action: 'subscribe', sessionId }));
  const diskPromise = observeRollout(codexHome, nativeSessionId, toolMarker, replyMarker);
  await processRun.done;
  const disk = await diskPromise;
  const wsTool = await waitFor(() => received.find((event) =>
    event.sessionId === sessionId
    && event.message.type === 'user'
    && JSON.stringify(event.message.content).includes(toolMarker)),
  30_000, `WS tool result ${index}`);
  const wsReply = await waitFor(() => received.find((event) =>
    event.sessionId === sessionId
    && event.message.type === 'assistant'
    && JSON.stringify(event.message.content).includes(replyMarker)),
  30_000, `WS assistant reply ${index}`);
  return {
    nativeSessionId,
    sessionId,
    toolLatencyMs: Math.max(0, wsTool.arrivedAt - disk.tool),
    replyLatencyMs: Math.max(0, wsReply.arrivedAt - disk.reply),
  };
}

let results = [];
try {
  results = await Promise.all([runSession(1), runSession(2)]);
  await delay(1000);
  for (const result of results) {
    const liveRows = received.filter((event) => event.sessionId === result.sessionId);
    const liveUuids = liveRows.map((event) => event.message.uuid).filter(Boolean);
    assertUnique(liveUuids, `live WS ${result.sessionId}`);
    if (result.toolLatencyMs > 3000 || result.replyLatencyMs > 3000) {
      throw new Error(`WS latency exceeded 3000ms for ${result.sessionId}`);
    }

    const cached = await fetchJson(
      `${server}/api/bridge/messages?session=${encodeURIComponent(result.sessionId)}&limit=500`,
      apiKey,
    );
    const cachedUuids = (cached.messages || []).map((message) => message.uuid).filter(Boolean);
    assertUnique(cachedUuids, `DDB ${result.sessionId}`);
    if (!(cached.messages || []).some((message) =>
      JSON.stringify(message.content).includes(`APEEK_E2E_REPLY_${runId}`))) {
      throw new Error(`DDB missing final assistant reply for ${result.sessionId}`);
    }
  }

  const catalog = await fetchJson(
    `${server}/api/bridge/sessions?device=${encodeURIComponent(deviceName)}&project=${encodeURIComponent(projectHash)}`,
    apiKey,
  );
  for (const result of results) {
    const session = (catalog.sessions || []).find((item) => item.sessionId === result.sessionId);
    if (!session || session.runtime !== 'codex' || session.status !== 'completed') {
      throw new Error(`Final Codex metadata missing or incorrect for ${result.sessionId}`);
    }
  }

  console.log(JSON.stringify({
    sessions: results.length,
    maxToolLatencyMs: Math.round(Math.max(...results.map((result) => result.toolLatencyMs))),
    maxReplyLatencyMs: Math.round(Math.max(...results.map((result) => result.replyLatencyMs))),
    duplicateWsUuids: 0,
    duplicateDdbUuids: 0,
    finalStatus: 'completed',
  }, null, 2));
} finally {
  try {
    await fetchJson(`${server}/api/bridge/delete`, apiKey, {
      method: 'POST',
      body: JSON.stringify({
        deviceName,
        sessionIds: results.map((result) => result.sessionId),
        projectHashes: [projectHash],
      }),
    });
  } catch {}
  watcher.stop();
  app.close();
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(codexHome, { recursive: true, force: true });
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} contains duplicate UUIDs`);
  }
}

process.exit(0);
