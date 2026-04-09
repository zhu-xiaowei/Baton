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
export function getSessionStatus(sessionId, filePath, runningInfo) {
  // Check if this exact session has a CC process
  if (!runningInfo.sessions.has(sessionId)) {
    // Fallback: CC might not have --resume (new session), check project
    const projectHash = path.basename(path.dirname(filePath));
    if (!runningInfo.projects.has(projectHash)) return 'stopped';
    // Project has CC but no session match — could be a different session
    if (runningInfo.sessions.size > 0) return 'stopped';
    // No session IDs detected at all (edge case) — fall through to jsonl check
  }

  // Read last few lines of jsonl to check stop_reason
  try {
    const buf = Buffer.alloc(8192);
    const fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const readStart = Math.max(0, stat.size - 8192);
    const bytesRead = fs.readSync(fd, buf, 0, 8192, readStart);
    fs.closeSync(fd);

    const tail = buf.slice(0, bytesRead).toString('utf-8');
    const lines = tail.split('\n').filter(l => l.trim());

    // Scan from last line backwards
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
      let entry;
      try { entry = JSON.parse(lines[i]); } catch { continue; }

      if (entry.type === 'last-prompt') return 'idle';

      if (entry.type === 'assistant' && entry.message) {
        const sr = entry.message.stop_reason;
        if (sr === 'end_turn') return 'idle';
        if (sr === 'tool_use' || sr === null) return 'running';
      }

      if (entry.type === 'user' && Array.isArray(entry.message?.content)) {
        const hasToolResult = entry.message.content.some(c => c.type === 'tool_result');
        if (hasToolResult) return 'running';
      }
    }
  } catch {}

  return 'idle';
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
