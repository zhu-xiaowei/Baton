import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { CLAUDE_PROJECTS } from './config.mjs';

export function getPreview(filePath) {
  try {
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    let aiTitle = '';
    let firstUserMsg = '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'ai-title' && msg.aiTitle) aiTitle = msg.aiTitle;
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

export function getModel(filePath) {
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

export function readableProjectName(projectHash) {
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

/**
 * Determine session status from CC process state + jsonl content.
 * Returns "running" | "idle" | "stopped"
 *
 * - stopped: no CC process for this session
 * - running: CC process on this session + jsonl shows active work
 * - idle: CC process on this session + jsonl shows waiting for user
 *
 * @param {string} sessionId - the session UUID
 * @param {string} filePath - path to .jsonl file
 * @param {Object} runningInfo - { projects: Set<hash>, sessions: Set<sessionId> }
 */
/**
 * Pure function: given a parsed jsonl entry, return status or null (not a status-relevant type).
 */
export function statusFromEntry(entry) {
  if (!entry) return null;
  const t = entry.type;
  if (t === 'last-prompt') return 'idle';
  if (t === 'assistant' && entry.message) {
    const sr = entry.message.stop_reason;
    if (sr === null) return 'running'; // streaming
    if (sr === 'tool_use') return 'running';
    if (sr === 'end_turn' || sr === 'max_tokens' || sr === 'stop_sequence') return 'idle';
  }
  if (t === 'user') return 'running';
  return null; // file-history-snapshot, queue-operation, etc.
}

/**
 * Read last lines of jsonl and determine content status.
 */
function readStatusFromFile(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;
    if (fileSize === 0) { fs.closeSync(fd); return 'idle'; }

    // Find last 6 newlines via reverse scan
    const newlines = [];
    const chunkSize = 4096;
    for (let pos = fileSize - 2; pos >= 0 && newlines.length < 6; pos -= chunkSize) {
      const start = Math.max(0, pos - chunkSize + 1);
      const len = pos - start + 1;
      const chunk = Buffer.alloc(len);
      fs.readSync(fd, chunk, 0, len, start);
      for (let j = len - 1; j >= 0 && newlines.length < 6; j--) {
        if (chunk[j] === 0x0A) newlines.push(start + j);
      }
    }

    const readFrom = newlines.length > 0 ? newlines[newlines.length - 1] + 1 : 0;
    const tailLen = fileSize - readFrom;
    const tailBuf = Buffer.alloc(tailLen);
    fs.readSync(fd, tailBuf, 0, tailLen, readFrom);
    fs.closeSync(fd);

    const lines = tailBuf.toString('utf-8').split('\n').filter(l => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry;
      try { entry = JSON.parse(lines[i]); } catch {
        if (i === lines.length - 1) return 'running'; // CC mid-write
        continue;
      }
      const s = statusFromEntry(entry);
      if (s) return s;
    }
  } catch {}
  return 'idle';
}

/**
 * Determine session status. Used by syncSessions() and checkStopped().
 * Watcher uses statusFromEntry() directly with already-parsed data.
 */
export function getSessionStatus(sessionId, filePath, runningInfo) {
  // 1. No CC process for this project → stopped
  if (!runningInfo.sessions.has(sessionId)) {
    const projectHash = path.basename(path.dirname(filePath));
    if (!runningInfo.projects.has(projectHash)) return 'stopped';
    if (runningInfo.sessions.size > 0) return 'stopped';
  }

  // 2. Read jsonl content to determine status
  const contentStatus = readStatusFromFile(filePath);

  // 3. VS Code (no --resume): if content says idle and file is stale → stopped
  //    If content says running (e.g. pending Agent tool_use), keep running regardless of mtime
  if (!runningInfo.sessions.has(sessionId) && contentStatus === 'idle') {
    try {
      if (Date.now() - fs.statSync(filePath).mtimeMs > 300_000) return 'stopped';
    } catch { return 'stopped'; }
  }

  return contentStatus;
}

/**
 * Detect running CC processes. Returns { projects: Set<hash>, sessions: Set<sessionId> }
 * - projects: project directory hashes with active CC processes
 * - sessions: exact session IDs extracted from --resume args
 */
export function getRunningInfo() {
  const projects = new Set();
  const sessions = new Set();
  try {
    const lines = execSync('ps aux 2>/dev/null').toString().trim().split('\n');
    for (const line of lines) {
      if (!line.includes('claude') || line.includes('grep')) continue;
      const parts = line.trim().split(/\s+/);
      const pid = parts[1];
      if (!pid || isNaN(pid)) continue;

      // Extract --resume sessionId from process args
      const resumeMatch = line.match(/--resume\s+([0-9a-f-]{36})/);
      if (resumeMatch) sessions.add(resumeMatch[1]);

      try {
        const cwd = process.platform === 'darwin'
          ? execSync(`lsof -p ${pid} 2>/dev/null | grep cwd | awk '{print $NF}'`).toString().trim()
          : fs.readlinkSync(`/proc/${pid}/cwd`);
        if (cwd) projects.add(path.resolve(cwd).replace(/[^a-zA-Z0-9-]/g, '-'));
      } catch {}
    }
  } catch {}
  return { projects, sessions };
}

// Find .jsonl file path for a sessionId
export function findSessionFile(sessionId) {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return null;
  for (const project of fs.readdirSync(CLAUDE_PROJECTS)) {
    const filePath = path.join(CLAUDE_PROJECTS, project, `${sessionId}.jsonl`);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}
