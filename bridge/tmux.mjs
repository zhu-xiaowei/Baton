import { execSync } from 'child_process';
import { findSessionFile } from './session.mjs';
import path from 'path';

let _tmuxAvailable = null;

/** Check if tmux is installed. Cached after first call. */
export function hasTmux() {
  if (_tmuxAvailable === null) {
    try {
      execSync('which tmux', { stdio: 'ignore' });
      _tmuxAvailable = true;
    } catch {
      _tmuxAvailable = false;
    }
  }
  return _tmuxAvailable;
}

/**
 * Find the tmux pane target for a given PID.
 * Walks up the process tree to find a PID that lives inside a tmux pane.
 * Returns target string like "session:0.1" or null.
 */
export function findTmuxPane(pid) {
  if (!hasTmux()) return null;
  try {
    // List all tmux panes with their PIDs
    const output = execSync(
      'tmux list-panes -a -F "#{pane_pid} #{session_name}:#{window_index}.#{pane_index}"',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
    ).trim();
    if (!output) return null;

    const panes = new Map();
    for (const line of output.split('\n')) {
      const [panePid, target] = line.split(' ', 2);
      if (panePid && target) panes.set(panePid, target);
    }

    // Walk up the process tree from the given PID
    let currentPid = String(pid);
    for (let i = 0; i < 10; i++) {
      if (panes.has(currentPid)) return panes.get(currentPid);
      try {
        const ppid = execSync(`ps -o ppid= -p ${currentPid}`, { encoding: 'utf-8' }).trim();
        if (!ppid || ppid === '0' || ppid === '1' || ppid === currentPid) break;
        currentPid = ppid;
      } catch { break; }
    }
  } catch {}
  return null;
}

/** Send keystrokes to a tmux pane. */
export function sendKeys(target, text) {
  if (!hasTmux()) throw new Error('tmux not installed');
  // Use -- to prevent send-keys from interpreting text as flags
  // Escape double quotes in text
  const escaped = text.replace(/"/g, '\\"');
  execSync(`tmux send-keys -t "${target}" -- "${escaped}" Enter`, { stdio: 'ignore' });
}

/** Create a new detached tmux session and run a command. */
export function newTmuxSession(name, cwd, command) {
  if (!hasTmux()) throw new Error('tmux not installed');
  // -d = detached, -s = session name, -c = working directory
  execSync(`tmux new-session -d -s "${name}" -c "${cwd}"`, { stdio: 'ignore' });
  if (command) {
    execSync(`tmux send-keys -t "${name}" "${command}" Enter`, { stdio: 'ignore' });
  }
}

/**
 * Find Claude Code PID(s) with their project info and tmux status.
 * Returns array of { pid, cwd, projectHash, tmuxTarget }
 */
export function getClaudeProcesses() {
  const results = [];
  try {
    const pids = execSync('pgrep -f "claude" 2>/dev/null', { encoding: 'utf-8' }).trim().split('\n');
    for (const pid of pids) {
      if (!pid) continue;
      try {
        const cwd = process.platform === 'darwin'
          ? execSync(`lsof -p ${pid} 2>/dev/null | grep cwd | awk '{print $NF}'`, { encoding: 'utf-8' }).trim()
          : (() => { try { return require('fs').readlinkSync(`/proc/${pid}/cwd`); } catch { return ''; } })();
        if (!cwd) continue;
        const projectHash = path.resolve(cwd).replace(/[^a-zA-Z0-9-]/g, '-');
        const tmuxTarget = findTmuxPane(pid);
        results.push({ pid: Number(pid), cwd, projectHash, tmuxTarget });
      } catch {}
    }
  } catch {}
  return results;
}

/**
 * Find tmux target for a given sessionId.
 * Resolves sessionId → project → Claude PID → tmux pane.
 */
export function findTmuxTargetForSession(sessionId) {
  const filePath = findSessionFile(sessionId);
  if (!filePath) return null;

  // Extract project hash from file path: .../projects/<hash>/<sessionId>.jsonl
  const parts = filePath.split(path.sep);
  const projIdx = parts.indexOf('projects');
  if (projIdx < 0 || projIdx + 1 >= parts.length) return null;
  const projectHash = parts[projIdx + 1];

  // Find a running Claude process for this project
  const procs = getClaudeProcesses();
  const match = procs.find(p => p.projectHash === projectHash && p.tmuxTarget);
  return match ? match.tmuxTarget : null;
}

/**
 * Send arrow-key selection to a Claude Code session via tmux.
 * n=0 means just Enter (first option), n=1 means Down+Enter, etc.
 * Returns { ok, error? }
 */
export function sendArrowSelect(sessionId, n) {
  if (!hasTmux()) return { ok: false, error: 'tmux not installed' };

  const target = findTmuxTargetForSession(sessionId);
  if (!target) return { ok: false, error: 'session not found in tmux' };

  try {
    for (let i = 0; i < n; i++) {
      execSync(`tmux send-keys -t "${target}" Down`, { stdio: 'ignore' });
    }
    execSync(`tmux send-keys -t "${target}" Enter`, { stdio: 'ignore' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Navigate to "Type something" option, type text, then Enter.
 * CC's AskUserQuestion "Other" option is an inline input — just type after navigating.
 */
export function sendTypeInput(sessionId, n, text) {
  if (!hasTmux()) return { ok: false, error: 'tmux not installed' };

  const target = findTmuxTargetForSession(sessionId);
  if (!target) return { ok: false, error: 'session not found in tmux' };

  try {
    // Navigate to the "Type something" / "Other" option
    for (let i = 0; i < n; i++) {
      execSync(`tmux send-keys -t "${target}" Down`, { stdio: 'ignore' });
    }
    // Type the text directly (inline input activates on focus)
    const escaped = text.replace(/"/g, '\\"');
    execSync(`tmux send-keys -t "${target}" -- "${escaped}"`, { stdio: 'ignore' });
    // Submit
    execSync(`tmux send-keys -t "${target}" Enter`, { stdio: 'ignore' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Send a single key to a Claude Code session (no Enter appended).
 * Used for permission prompts (y/n/a) and Escape.
 * Returns { ok, error? }
 */
export function sendKey(sessionId, key) {
  if (!hasTmux()) return { ok: false, error: 'tmux not installed' };
  const target = findTmuxTargetForSession(sessionId);
  if (!target) return { ok: false, error: 'session not found in tmux' };
  try {
    execSync(`tmux send-keys -t "${target}" "${key}"`, { stdio: 'ignore' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Send a message to a Claude Code session via tmux.
 * Returns { ok, error? }
 */
export function sendMessageToSession(sessionId, text) {
  if (!hasTmux()) return { ok: false, error: 'tmux not installed' };

  const target = findTmuxTargetForSession(sessionId);
  if (!target) return { ok: false, error: 'session not found in tmux' };

  try {
    sendKeys(target, text);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
