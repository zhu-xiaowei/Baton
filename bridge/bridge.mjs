#!/usr/bin/env node
/**
 * Claude Code Bridge — watches .jsonl session files and syncs to server.
 *
 * Config: ~/.claude-bridge/config.json
 *   { "server": "https://xxx.execute-api.xxx.amazonaws.com/v1", "apiKey": "sk-xxx", "deviceName": "MyMac" }
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execSync } from 'child_process';
import sharp from 'sharp';

const BRIDGE_HOME = path.join(os.homedir(), '.claude-bridge');
const CONFIG_PATH = path.join(BRIDGE_HOME, 'config.json');
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const VALID_TYPES = new Set(['user', 'assistant', 'system', 'summary']);
const SYNC_INTERVAL = 60_000;
const MAX_POST_BYTES = 4 * 1024 * 1024; // 4MB per POST (Lambda limit 6MB)

// Parse CLI args
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--server' && args[i + 1]) parsed.server = args[++i];
    else if (args[i] === '--key' && args[i + 1]) parsed.apiKey = args[++i];
    else if (args[i] === '--name' && args[i + 1]) parsed.deviceName = args[++i];
  }
  return parsed;
}

// Load or create config
const cliArgs = parseArgs();
let CONFIG;

if (cliArgs.server && cliArgs.apiKey) {
  CONFIG = {
    server: cliArgs.server,
    apiKey: cliArgs.apiKey,
    deviceName: cliArgs.deviceName || os.hostname(),
  };
  fs.mkdirSync(BRIDGE_HOME, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG, null, 2));
  console.log(`Config saved to ${CONFIG_PATH}`);
} else if (fs.existsSync(CONFIG_PATH)) {
  CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
} else {
  console.error('Usage: node bridge.mjs --server URL --key API_KEY [--name DEVICE_NAME]');
  process.exit(1);
}

// Track sync position: sessionId → line number (last synced line)
const synced = new Map();
// Sessions active in last 24h — only these get synced in periodic poll
const recentSessions = new Set();
let isInitialSync = true;

// ===== HTTP POST =====
async function post(endpoint, data) {
  try {
    const res = await fetch(`${CONFIG.server}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.apiKey },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`POST ${endpoint} → ${res.status}: ${text.slice(0, 200)}`);
    }
    return res;
  } catch (err) {
    console.error(`POST ${endpoint} failed: ${err.message}`);
    return null;
  }
}

// ===== Image compression + S3 upload =====
async function processImage(base64Data) {
  const buffer = Buffer.from(base64Data, 'base64');
  const compressed = await sharp(buffer)
    .resize(720, 720, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();

  // Unique key from first 8KB + file size
  const hashInput = Buffer.concat([compressed.slice(0, 8192), Buffer.from(String(compressed.length))]);
  const hash = crypto.createHash('md5').update(hashInput).digest('hex');
  const key = `${hash}.jpg`;

  // Upload via Lambda → S3
  await post('/api/bridge/upload-image', {
    key,
    data: compressed.toString('base64'),
  });

  return key;
}

// ===== Extract app-needed fields from raw .jsonl message =====
async function extractForApp(msg) {
  let content = msg.message?.content ?? '';
  if (Array.isArray(content)) {
    // Step 1: compress all images in parallel (fast, ~25ms/image)
    const imageJobs = [];
    for (let i = 0; i < content.length; i++) {
      if (content[i].type === 'image') {
        const b64 = content[i].source?.data || content[i].source?.bytes || '';
        if (b64) {
          imageJobs.push({ index: i, promise: processImage(b64) });
        }
      }
    }
    // Wait for all compressions + uploads to finish
    const results = await Promise.allSettled(imageJobs.map(j => j.promise));

    // Step 2: build final content
    content = content.map((block, i) => {
      if (block.type === 'image') {
        const job = imageJobs.find(j => j.index === i);
        if (job) {
          const result = results[imageJobs.indexOf(job)];
          if (result.status === 'fulfilled') return { type: 'image', key: result.value };
          console.error(`Image upload failed: ${result.reason?.message}`);
        }
        return { type: 'image', placeholder: true };
      }
      if (block.type === 'tool_result') {
        const raw = JSON.stringify(block);
        if (raw.length > 2000) {
          const text = typeof block.content === 'string' ? block.content
            : Array.isArray(block.content) ? block.content.map(c => c.text || '').join('')
            : JSON.stringify(block.content);
          return { ...block, content: text.slice(0, 500) + `... (${text.length} chars)` };
        }
      }
      return block;
    });
  }
  return {
    uuid: msg.uuid || msg.leafUuid || '',
    type: msg.type || '',
    content,
    timestamp: msg.timestamp || '',
  };
}

// ===== Read new messages from a session file =====
// Uses line-number tracking: only reads lines after last synced position.
async function readNewMessages(filePath, sessionId) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  const lastLine = synced.get(sessionId) ?? 0;
  const newMsgs = [];

  for (let i = lastLine; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let msg;
    try { msg = JSON.parse(lines[i]); } catch { continue; }
    if (!VALID_TYPES.has(msg.type)) continue;
    const extracted = await extractForApp(msg);
    if (extracted.uuid) newMsgs.push(extracted);
  }

  synced.set(sessionId, lines.length);
  return newMsgs;
}

// ===== Upload messages to DDB in byte-sized batches =====
async function uploadMessages(sessionId, messages) {
  if (messages.length === 0) return;
  let batch = [];
  let batchSize = 0;

  for (const msg of messages) {
    const msgJson = JSON.stringify(msg);
    if (batchSize + msgJson.length > MAX_POST_BYTES && batch.length > 0) {
      await post('/api/bridge/sync-messages', { sessionId, messages: batch });
      await new Promise(r => setTimeout(r, 200)); // Small delay between batches
      batch = [];
      batchSize = 0;
    }
    batch.push(msg);
    batchSize += msgJson.length;
  }
  if (batch.length > 0) {
    await post('/api/bridge/sync-messages', { sessionId, messages: batch });
  }
}

// ===== Get session preview (ai-title or first user message) =====
function getPreview(filePath) {
  try {
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    let aiTitle = '';
    let firstUserMsg = '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'ai-title' && msg.aiTitle) {
          aiTitle = msg.aiTitle;
        }
        if (!firstUserMsg && msg.type === 'user' && msg.message?.content) {
          const content = msg.message.content;
          const text = typeof content === 'string' ? content
            : Array.isArray(content) ? (content.find(c => c.type === 'text')?.text || '') : '';
          if (text.length > 3 && !text.startsWith('<') && text !== 'Warmup') {
            firstUserMsg = text.slice(0, 100);
          }
        }
      } catch {}
    }
    return aiTitle || firstUserMsg;
  } catch {}
  return '';
}

// ===== Get model from last assistant message =====
function getModel(filePath) {
  try {
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      try {
        const msg = JSON.parse(lines[i]);
        if (msg.type === 'assistant' && msg.message?.model) return msg.message.model;
      } catch {}
    }
  } catch {}
  return '';
}

// ===== Readable project name =====
function readableProjectName(projectHash) {
  const homeHash = path.resolve(os.homedir()).replace(/[^a-zA-Z0-9-]/g, '-');
  let remaining = projectHash;
  if (remaining.startsWith(homeHash)) remaining = remaining.slice(homeHash.length);
  remaining = remaining.replace(/^-/, '');
  if (!remaining) return '~';

  const segments = [];
  let currentDir = os.homedir();
  const parts = remaining.split('-');

  let i = 0;
  while (i < parts.length) {
    let matched = false;
    for (let len = parts.length - i; len >= 1; len--) {
      const candidate = parts.slice(i, i + len).join('-');
      const candidatePath = path.join(currentDir, candidate);
      try {
        if (fs.statSync(candidatePath).isDirectory()) {
          segments.push(candidate);
          currentDir = candidatePath;
          i += len;
          matched = true;
          break;
        }
      } catch {}
    }
    if (!matched) {
      segments.push(parts.slice(i).join('-'));
      break;
    }
  }
  return segments.join('/');
}

// ===== Detect running claude processes =====
function getRunningProjects() {
  const running = new Set();
  try {
    const pids = execSync('pgrep -f "claude" 2>/dev/null').toString().trim().split('\n');
    for (const pid of pids) {
      if (!pid) continue;
      try {
        const cwd = process.platform === 'darwin'
          ? execSync(`lsof -p ${pid} 2>/dev/null | grep cwd | awk '{print $NF}'`).toString().trim()
          : fs.readlinkSync(`/proc/${pid}/cwd`);
        if (cwd) running.add(path.resolve(cwd).replace(/[^a-zA-Z0-9-]/g, '-'));
      } catch {}
    }
  } catch {}
  return running;
}

// ===== Sync sessions + initial message upload =====
async function syncSessions() {
  if (!fs.existsSync(CLAUDE_PROJECTS)) {
    console.log('No claude projects directory found yet.');
    return;
  }
  const running = getRunningProjects();
  const recentCutoff = Date.now() - 86400_000; // 24h for periodic sync
  const sessions = [];
  const projectSessions = new Map(); // projectHash → [{ sessionId, mtime, filePath }]

  for (const project of fs.readdirSync(CLAUDE_PROJECTS)) {
    const projectDir = path.join(CLAUDE_PROJECTS, project);
    if (!fs.statSync(projectDir).isDirectory()) continue;
    const jsonlFiles = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl') && !f.startsWith('.'));

    for (const file of jsonlFiles) {
      const filePath = path.join(projectDir, file);
      const stat = fs.statSync(filePath);
      if (stat.size === 0) continue;
      const preview = getPreview(filePath);
      if (!preview) continue;
      const sessionId = file.replace('.jsonl', '');

      // Track recent sessions (24h) for periodic sync
      if (stat.mtimeMs > recentCutoff) recentSessions.add(sessionId);

      // Initial sync: all sessions; periodic sync: only recent 24h
      if (!isInitialSync && !recentSessions.has(sessionId)) continue;

      sessions.push({
        id: sessionId,
        project,
        projectName: readableProjectName(project),
        lastActive: stat.mtime.toISOString(),
        size: stat.size,
        preview,
        model: getModel(filePath),
        isRunning: running.has(project),
      });

      // Collect for top-2 selection
      if (!projectSessions.has(project)) projectSessions.set(project, []);
      projectSessions.get(project).push({ sessionId, mtime: stat.mtimeMs, filePath });
    }
  }

  // Upload session metadata
  await post('/api/bridge/sync-sessions', {
    deviceName: CONFIG.deviceName,
    os: process.platform,
    sessions,
  });
  if (isInitialSync) {
    console.log(`[sync] ${sessions.length} sessions (${running.size} active)`);
  } else {
    console.log(`[sync] ${sessions.length} recent sessions (${running.size} active)`);
  }

  // Initial message sync: active session per project (latest only) + recent 24h sessions
  // Active: for each running project, only the most recent session (the one being used)
  // Recent: mtime within 24h (user might review on phone)
  // Older: skip, can be loaded on-demand via WS in Phase 2
  const syncJobs = [];
  const syncedSessionIds = new Set();
  for (const [project, items] of projectSessions) {
    const sorted = items.sort((a, b) => b.mtime - a.mtime);
    const isActiveProject = running.has(project);

    for (let i = 0; i < sorted.length; i++) {
      const s = sorted[i];
      if (synced.has(s.sessionId) || syncedSessionIds.has(s.sessionId)) continue;
      const isActive = isActiveProject && i === 0; // only the latest session in a running project
      const isRecent = s.mtime > recentCutoff;
      if (!isActive && !isRecent) continue;
      syncedSessionIds.add(s.sessionId);
      syncJobs.push(async () => {
        const msgs = await readNewMessages(s.filePath, s.sessionId);
        if (msgs.length > 0) {
          await uploadMessages(s.sessionId, msgs);
          console.log(`[init] ${s.sessionId.slice(0, 8)}: ${msgs.length} messages (${isActive ? 'active' : 'recent'})`);
          return msgs.length;
        }
        return 0;
      });
    }
  }
  if (syncJobs.length > 0) console.log(`[init] syncing ${syncJobs.length} sessions (active + recent 24h)`);
  if (syncJobs.length > 0) {
    // Sliding window: always keep CONCURRENCY jobs running
    const CONCURRENCY = 4;
    let total = 0;
    let next = 0;
    const running = new Set();

    function launch() {
      while (running.size < CONCURRENCY && next < syncJobs.length) {
        const idx = next++;
        const p = syncJobs[idx]().then(n => { total += n; running.delete(p); });
        running.add(p);
      }
    }

    launch();
    while (running.size > 0) {
      await Promise.race(running); // Wait for any one to finish
      launch(); // Fill the slot
    }
    if (total > 0) console.log(`[init] ${total} messages synced to DDB`);
  }
  isInitialSync = false;
}

// ===== Watch .jsonl files =====
function startWatcher() {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return;
  const timers = new Map(); // sessionId → timer

  fs.watch(CLAUDE_PROJECTS, { recursive: true }, (_event, filename) => {
    if (!filename?.endsWith('.jsonl')) return;
    if (filename.includes('subagents')) return;
    const sessionId = path.basename(filename, '.jsonl');

    // Discard earlier event, only process the last one (100ms)
    if (timers.has(sessionId)) clearTimeout(timers.get(sessionId));
    timers.set(sessionId, setTimeout(() => {
      timers.delete(sessionId);
      processFileChange(filename, sessionId);
    }, 100));
  });

  async function processFileChange(filename, sessionId) {
    const filePath = path.join(CLAUDE_PROJECTS, filename);
    if (!fs.existsSync(filePath)) return;

    const stat = fs.statSync(filePath);

    const isNewSession = !synced.has(sessionId);
    const isResumedHistory = !isNewSession && !recentSessions.has(sessionId);

    const newMsgs = await readNewMessages(filePath, sessionId);
    if (newMsgs.length > 0) {
      await uploadMessages(sessionId, newMsgs);
      // TODO Phase 2: also push via WS for real-time
      console.log(`[watch] ${sessionId.slice(0, 8)}: +${newMsgs.length} messages`);

      // New session or resumed historical session — immediately sync metadata to DDB
      if (isNewSession || isResumedHistory) {
        const projectHash = path.basename(path.dirname(filename));
        const preview = getPreview(filePath) || 'New session';
        const running = getRunningProjects();
        await post('/api/bridge/sync-sessions', {
          deviceName: CONFIG.deviceName,
          os: process.platform,
          sessions: [{
            id: sessionId,
            project: projectHash,
            projectName: readableProjectName(projectHash),
            lastActive: stat.mtime.toISOString(),
            size: stat.size,
            preview,
            model: getModel(filePath),
            isRunning: running.has(projectHash),
          }],
        });
        recentSessions.add(sessionId);
        console.log(`[watch] ${isNewSession ? 'new' : 'resumed'} session ${sessionId.slice(0, 8)} synced`);
      }
    }
  }
}

// ===== Start =====
console.log(`claude-bridge started`);
console.log(`  device:   ${CONFIG.deviceName}`);
console.log(`  server:   ${CONFIG.server}`);
console.log(`  watching: ${CLAUDE_PROJECTS}`);

await syncSessions();
startWatcher();
setInterval(syncSessions, SYNC_INTERVAL);
