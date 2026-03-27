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

export function isSessionActive(project, mtime, runningProjects, latestMtimeByProject) {
  if (!runningProjects.has(project)) return false;
  if (mtime >= latestMtimeByProject.get(project)) return true;
  return Date.now() - mtime < 120_000;
}

export function getLatestMtimeByProject(items, runningProjects) {
  const latest = new Map();
  for (const { project, mtime } of items) {
    if (!runningProjects.has(project)) continue;
    if (!latest.has(project) || mtime > latest.get(project)) latest.set(project, mtime);
  }
  return latest;
}

export function getRunningProjects() {
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

// Find .jsonl file path for a sessionId
export function findSessionFile(sessionId) {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return null;
  for (const project of fs.readdirSync(CLAUDE_PROJECTS)) {
    const filePath = path.join(CLAUDE_PROJECTS, project, `${sessionId}.jsonl`);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}
