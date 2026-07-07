import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { CLAUDE_PROJECTS, CLAUDE_JOBS, CLAUDE_DAEMON_ROSTER, IS_WSL } from './config.mjs';
import { isTerminalBusy } from './tmux.mjs';

// Mirrors CC's SKIP_FIRST_PROMPT_PATTERN (sessionStorage.ts).
const SKIP_FIRST_PROMPT = /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/;

export function extractFirstPromptFromMsg(msg) {
  if (msg.type !== 'user' || msg.isMeta || msg.isCompactSummary) return '';
  const content = msg.message?.content;
  const texts = typeof content === 'string' ? [content]
    : Array.isArray(content) ? content.filter(b => b.type === 'text' && b.text).map(b => b.text)
    : [];
  for (const raw of texts) {
    const t = raw.replace(/\n/g, ' ').trim();
    if (!t) continue;
    const bash = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(t);
    if (bash) return `! ${bash[1].trim()}`;
    if (SKIP_FIRST_PROMPT.test(t)) continue;
    return t.length > 200 ? t.slice(0, 200).trim() + '…' : t;
  }
  return '';
}

export function getPreview(filePath) {
  try {
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    let customTitle = '';
    let aiTitle = '';
    let lastPrompt = '';
    let firstUserMsg = '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'custom-title' && msg.customTitle) customTitle = msg.customTitle;
        if (msg.type === 'ai-title' && msg.aiTitle) aiTitle = msg.aiTitle;
        if (msg.type === 'last-prompt' && msg.lastPrompt) lastPrompt = msg.lastPrompt;
        if (!firstUserMsg) {
          const fp = extractFirstPromptFromMsg(msg);
          if (fp) firstUserMsg = fp;
        }
      } catch {}
    }
    return customTitle || aiTitle || lastPrompt || firstUserMsg;
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
  let currentDir = os.homedir();
  const segments = [];

  // Windows hash on WSL: "C-Users-Admin-workspace" → resolve via /mnt/c/
  const winDriveMatch = projectHash.match(/^([A-Z])-/);
  if (winDriveMatch && process.env.WSL_DISTRO_NAME) {
    const drive = winDriveMatch[1].toLowerCase();
    currentDir = `/mnt/${drive}`;
    remaining = projectHash.slice(2);
  } else if (remaining.startsWith(homeHash)) {
    remaining = remaining.slice(homeHash.length);
    remaining = remaining.replace(/^-/, '');
    if (!remaining) return '~';
  } else {
    remaining = remaining.replace(/^-/, '');
  }

  if (!remaining) return currentDir;

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
  // last-prompt is a metadata snapshot CC re-appends near EOF (not a state signal),
  // so it's not turn-defining → keep scanning. (CC source: sessionStorage.ts.)
  if (t === 'assistant' && entry.message) {
    const sr = entry.message.stop_reason;
    if (sr === null) return 'running'; // streaming
    if (sr === 'tool_use') return 'running';
    if (sr === 'end_turn' || sr === 'max_tokens' || sr === 'stop_sequence') return 'idle';
  }
  if (t === 'user') {
    if (entry.isMeta || entry.isCompactSummary) return null; // meta, not a turn
    const c = entry.message?.content;
    if (Array.isArray(c)) {
      // [Request interrupted by user] or [Request interrupted by user for tool use]
      if (c.length === 1 && c[0].type === 'text'
        && c[0].text.startsWith('[Request interrupted by user')) return 'idle';
      // tool_result with is_error=true only (user interrupted during tool execution)
      if (c.every(b => b.type === 'tool_result') && c.every(b => b.is_error)) return 'idle';
    }
    if (typeof c === 'string') {
      const cs = c.trim();
      // Command finished → idle; noise & /clear (no reply) → skip; other
      // <command-name> falls through to 'running' (awaiting a reply).
      if (/^<local-command-stdout>/.test(cs)) return 'idle';
      if (/^<(?:local-command-caveat|task-notification|system-reminder)/.test(cs)) return null;
      if (/^<command-name>\/?clear<\/command-name>/.test(cs)) return null;
    }
    return 'running';
  }
  return null; // file-history-snapshot, queue-operation, etc.
}

// Last time content judged each session 'running' — for the downgrade debounce.
const lastRunningTs = new Map();
const RUNNING_DEBOUNCE_MS = 10_000;

// Resolve content status, holding 'running' across end_turn flicker before
// downgrading: debounce → terminal truth (capture-pane) → process fallback.
// procAliveFn is lazy — only the no-pane branch pays for `ps aux`.
export function resolveStatus(sessionId, contentStatus, procAliveFn) {
  if (contentStatus === 'running') {
    lastRunningTs.set(sessionId, Date.now());
    return 'running';
  }
  const last = lastRunningTs.get(sessionId);
  if (last && Date.now() - last < RUNNING_DEBOUNCE_MS) return 'running';
  const busy = isTerminalBusy(sessionId);
  if (busy === true) { lastRunningTs.set(sessionId, Date.now()); return 'running'; }
  if (busy === false) return contentStatus; // terminal confirms idle/stopped
  return procAliveFn() ? 'idle' : 'stopped'; // no pane → process fallback
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
 * True if the last status-relevant jsonl entry is an `assistant` turn (i.e. the
 * file's last word is a tool_use, resolved or not — resolved ones are a closed
 * turn awaiting the next user message; unresolved ones are the normal
 * needsPermission wait). Either way there's nothing dangling in CC's memory
 * for stall.mjs to rescue: only a trailing `user` entry (a fully-closed prior
 * turn, with the *next* turn's tool_use never having reached jsonl at all) can
 * mean a stuck-in-memory wizard. Used as a safety gate — pane content alone
 * can't tell "flushed tool_use the user is normally answering" apart from
 * "wizard stuck in memory", since both render identically on screen.
 */
export function hasNoDanglingTurn(filePath) {
  try {
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      let entry;
      try { entry = JSON.parse(lines[i]); } catch { continue; }
      if (statusFromEntry(entry)) return entry.type === 'user';
    }
  } catch {}
  return false;
}

/**
 * Determine session status. Used by syncSessions() and checkStopped().
 * Watcher uses statusFromEntry() directly with already-parsed data.
 */
export function getSessionStatus(sessionId, filePath, runningInfo) {
  // WSL monitoring Windows CC: can't detect processes, use mtime + content only
  const wslMode = IS_WSL && CLAUDE_PROJECTS.startsWith('/mnt/');

  // 1. No CC process for this project → stopped (skip on WSL)
  if (!wslMode && !runningInfo.sessions.has(sessionId)) {
    const projectHash = path.basename(path.dirname(filePath));
    if (!runningInfo.projects.has(projectHash)) return 'stopped';
    if (runningInfo.sessions.size > 0) return 'stopped';
  }

  // 2. Read jsonl content to determine status
  const contentStatus = readStatusFromFile(filePath);

  // 3. File stale > 5min → stopped regardless of content
  //    A truly running session always writes to jsonl, keeping mtime fresh
  if (!runningInfo.sessions.has(sessionId)) {
    try {
      if (Date.now() - fs.statSync(filePath).mtimeMs > 300_000) return 'stopped';
    } catch { return 'stopped'; }
  }

  // 4. Debounce + terminal-truth before downgrading running→idle/stopped.
  return resolveStatus(sessionId, contentStatus, () => runningInfo.sessions.has(sessionId));
}

/**
 * Detect running CC processes. Returns { projects: Set<hash>, sessions: Set<sessionId> }
 * - projects: project directory hashes with active CC processes
 * - sessions: exact session IDs extracted from --resume args
 *
 * On WSL watching /mnt/ paths: Windows CC processes are invisible to Linux ps,
 * so we return empty sets and rely on mtime heuristic (same as VS Code CC).
 */
export function getRunningInfo() {
  const projects = new Set();
  const sessions = new Set();

  // WSL bridge monitoring Windows CC: can't see Windows processes, use mtime fallback
  if (IS_WSL && CLAUDE_PROJECTS.startsWith('/mnt/')) {
    return { projects, sessions };
  }

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

  for (const sid of getDaemonRunningSessionIds()) {
    sessions.add(sid);
  }

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

/**
 * Single source of truth: map a daemon job's state.json to our 3-state agentState.
 * Mirrors `claude agents` TUI: Working / Needs input / Completed.
 *
 * `state` (lifecycle) is authoritative — `tempo` (cadence) lags and can stay
 * 'active' after the job blocks/fails, so it's only a fallback when state is absent.
 */
export function mapAgentState(state) {
  const st = state.state || '';
  if (st === 'done' || st === 'completed') return 'done';      // Completed
  if (st === 'blocked' || st === 'failed') return 'blocked';   // Needs input
  if (st) return 'running';                                    // Working
  const tempo = state.tempo || '';
  return tempo === 'blocked' ? 'blocked' : tempo === 'active' ? 'running' : 'done';
}

// Match `claude agents` display: blocked shows `needs` (the question awaiting
// the user); other states show `detail` (work summary).
export function agentDetailFor(state) {
  return mapAgentState(state) === 'blocked'
    ? (state.needs || state.detail || '')
    : (state.detail || state.needs || '');
}

export function getDaemonSessions() {
  const result = new Map();
  if (!fs.existsSync(CLAUDE_JOBS)) return result;
  try {
    for (const dir of fs.readdirSync(CLAUDE_JOBS)) {
      const statePath = path.join(CLAUDE_JOBS, dir, 'state.json');
      if (!fs.existsSync(statePath)) continue;
      try {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        if (state.backend !== 'daemon' || !state.sessionId) continue;
        result.set(state.sessionId, {
          isAgent: true,
          agentName: state.name || '',
          agentDetail: agentDetailFor(state),
          agentState: mapAgentState(state),
        });
      } catch {}
    }
  } catch {}
  return result;
}

export function getDaemonRunningSessionIds() {
  const sessions = new Set();
  try {
    if (!fs.existsSync(CLAUDE_DAEMON_ROSTER)) return sessions;
    const roster = JSON.parse(fs.readFileSync(CLAUDE_DAEMON_ROSTER, 'utf-8'));
    if (!roster.workers) return sessions;
    if (roster.supervisorPid) {
      try { process.kill(roster.supervisorPid, 0); } catch { return sessions; }
    }
    for (const w of Object.values(roster.workers)) {
      if (w.sessionId) sessions.add(w.sessionId);
    }
  } catch {}
  return sessions;
}
