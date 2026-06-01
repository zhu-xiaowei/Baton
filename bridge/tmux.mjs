import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import { readableProjectName } from './session.mjs';
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

/** Send text via bracketed paste (-p keeps newlines literal) + C-m submit.
 *  C-m not Enter: Ink swallows Enter after a bracketed paste. See docs/claude-code-bridge.md. */
export function sendKeys(target, text) {
  if (!hasTmux()) throw new Error('tmux not installed');
  spawnSync('tmux', ['send-keys', '-t', target, 'C-u'], { stdio: 'ignore' });
  spawnSync('tmux', ['load-buffer', '-b', 'bridge_send', '-'], { input: text, stdio: ['pipe', 'pipe', 'pipe'] });
  spawnSync('tmux', ['paste-buffer', '-p', '-b', 'bridge_send', '-t', target, '-d'], { stdio: 'ignore' });
  spawnSync('tmux', ['send-keys', '-t', target, 'C-m'], { stdio: 'ignore' });
}

/**
 * Kill stale apeek_ tmux sessions (idle > 1 day, no recent .jsonl writes).
 * Called before creating a new tmux session.
 */
export function cleanStaleSessions() {
  try {
    const output = execSync(
      'tmux list-sessions -F "#{session_name} #{session_activity}" 2>/dev/null',
      { encoding: 'utf-8' }
    ).trim();
    if (!output) return;

    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    for (const line of output.split('\n')) {
      const [name, activity] = line.split(' ');
      if (!name.startsWith('apeek_')) continue;
      const ts = parseInt(activity, 10);
      if (!ts) continue;
      if (ts * 1000 < oneDayAgo) {
        execSync(`tmux kill-session -t "${name}"`, { stdio: 'ignore' });
        console.log(`[tmux] killed stale session: ${name}`);
      }
    }
  } catch {}
}

/** Create a new detached tmux session and run a command. */
export function newTmuxSession(name, cwd, command, opts) {
  if (!hasTmux()) throw new Error('tmux not installed');
  try { execSync(`tmux kill-session -t "${name}" 2>/dev/null`, { stdio: 'ignore' }); } catch {}

  var sizeArgs = opts && opts.height ? ` -x 200 -y ${opts.height}` : '';
  execSync(`tmux new-session -d -s "${name}"${sizeArgs} -c "${cwd}"`);

  if (command) {
    execSync(`tmux send-keys -t "${name}" "${command}" Enter`);
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
          : (() => { try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return ''; } })();
        if (!cwd) continue;
        const projectHash = path.resolve(cwd).replace(/[^a-zA-Z0-9-]/g, '-');
        const tmuxTarget = findTmuxPane(pid);
        // Get command line args to identify which sessionId this CC is running
        let args = '';
        try {
          args = execSync(`ps -o args= -p ${pid} 2>/dev/null`, { encoding: 'utf-8' }).trim();
        } catch {}
        results.push({ pid: Number(pid), cwd, projectHash, tmuxTarget, args });
      } catch {}
    }
  } catch {}
  return results;
}

/**
 * Find tmux target for a given sessionId.
 * 1. Match CC process with --resume <sessionId> in args
 * 2. Fallback: match tmux session named apeek_*_<sessionId[:8]> (for new sessions renamed after creation)
 */
export function findTmuxTargetForSession(sessionId) {
  // Primary: match CC process with this exact sessionId in its args (--resume <id>)
  const procs = getClaudeProcesses();
  const exact = procs.find(p => p.tmuxTarget && p.args.includes(sessionId));
  if (exact) return exact.tmuxTarget;

  // Fallback: match tmux session name ending with sessionId prefix, verify claude is running inside
  if (!hasTmux()) return null;
  const suffix = `_${sessionId.slice(0, 8)}`;
  try {
    const output = execSync(
      'tmux list-sessions -F "#{session_name}" 2>/dev/null',
      { encoding: 'utf-8' }
    ).trim();
    for (const name of output.split('\n')) {
      if (name.startsWith('apeek_') && name.endsWith(suffix)) {
        // Verify the pane is actually running claude, not a leftover bash shell
        try {
          const cmd = execSync(`tmux list-panes -t "${name}" -F "#{pane_current_command}" 2>/dev/null`, { encoding: 'utf-8' }).trim();
          if (cmd.includes('claude') || cmd.includes('node')) return name;
        } catch {}
      }
    }
  } catch {}
  return null;
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
      spawnSync('tmux', ['send-keys', '-t', target, 'Down'], { stdio: 'ignore' });
    }
    spawnSync('tmux', ['send-keys', '-t', target, 'Enter'], { stdio: 'ignore' });
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
      spawnSync('tmux', ['send-keys', '-t', target, 'Down'], { stdio: 'ignore' });
    }
    spawnSync('tmux', ['load-buffer', '-b', 'bridge_send', '-'], { input: text, stdio: ['pipe', 'pipe', 'pipe'] });
    // Bracketed paste + C-m, same as sendKeys.
    spawnSync('tmux', ['paste-buffer', '-p', '-b', 'bridge_send', '-t', target, '-d'], { stdio: 'ignore' });
    spawnSync('tmux', ['send-keys', '-t', target, 'C-m'], { stdio: 'ignore' });
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
    spawnSync('tmux', ['send-keys', '-t', target, key], { stdio: 'ignore' });
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
  if (!target) return { ok: false, error: 'no_tmux_target' };

  try {
    sendKeys(target, text);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Resolve projectHash back to an absolute directory path.
 * Hash rule: path.resolve(cwd).replace(/[^a-zA-Z0-9-]/g, '-')
 * e.g. "-Users-xiaoweii-workspace-rn-agentpeek" → "/Users/xiaoweii/workspace/rn/agentpeek"
 *
 * Windows CC generates hashes like "C-Users-Admin-workspace-project" (drive letter prefix).
 * On WSL, we map these to /mnt/c/Users/Admin/workspace/project.
 */
export function projectHashToPath(projectHash) {
  const homeDir = os.homedir();
  const homeHash = path.resolve(homeDir).replace(/[^a-zA-Z0-9-]/g, '-');
  let remaining = projectHash;
  let currentDir = '/';

  // Windows hash detection: starts with single uppercase letter (drive letter)
  // e.g. "C-Users-Admin-workspace" → /mnt/c/Users/Admin/workspace (on WSL)
  const winDriveMatch = projectHash.match(/^([A-Z])-/);
  if (winDriveMatch && process.env.WSL_DISTRO_NAME) {
    const drive = winDriveMatch[1].toLowerCase();
    currentDir = `/mnt/${drive}`;
    remaining = projectHash.slice(2); // remove "C-"
  } else if (remaining.startsWith(homeHash)) {
    remaining = remaining.slice(homeHash.length).replace(/^-/, '');
    currentDir = homeDir;
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
          currentDir = candidatePath;
          i += len;
          matched = true;
          break;
        }
      } catch {}
    }
    if (!matched) {
      currentDir = path.join(currentDir, parts.slice(i).join('-'));
      break;
    }
  }
  return currentDir;
}

/**
 * Launch Claude Code in a new tmux session for a given sessionId + project.
 * Returns the tmux session name, or throws on failure.
 * Naming: apeek_{projectName}_{sessionId first 8 chars}
 */
export function launchClaudeSession(sessionId, projectHash) {
  if (!hasTmux()) throw new Error('tmux not installed');

  const projectPath = projectHashToPath(projectHash);
  if (!fs.existsSync(projectPath)) {
    throw new Error('Project directory not found. Please recreate the project.');
  }
  const projectName = readableProjectName(projectHash)
    .split('/').pop()
    .replace(/[^a-zA-Z0-9_.-]/g, '_');
  const tmuxName = `apeek_${projectName}_${sessionId.slice(0, 8)}`;

  newTmuxSession(tmuxName, projectPath, `claude --resume ${sessionId}`);
  return tmuxName;
}

export async function launchAgentsSession(sessionId, agentCwd, agentName) {
  if (!hasTmux()) throw new Error('tmux not installed');
  if (!agentCwd || !fs.existsSync(agentCwd)) throw new Error('Agent cwd not found');

  const tmuxName = `apeek_agents_${sessionId.slice(0, 8)}`;

  newTmuxSession(tmuxName, agentCwd, `claude agents --cwd "${agentCwd}"`, { height: 1000 });

  const ready = await waitForAgentsList(tmuxName);
  if (!ready) {
    try { execSync(`tmux kill-session -t "${tmuxName}" 2>/dev/null`, { stdio: 'ignore' }); } catch {}
    throw new Error('claude agents TUI did not load');
  }

  const navResult = await navigateToAgent(tmuxName, agentName);
  if (!navResult.ok) {
    try { execSync(`tmux kill-session -t "${tmuxName}" 2>/dev/null`, { stdio: 'ignore' }); } catch {}
    throw new Error(navResult.error);
  }

  spawnSync('tmux', ['send-keys', '-t', tmuxName, 'Right'], { stdio: 'ignore' });

  const entered = await waitForAgentPrompt(tmuxName, agentName);
  if (!entered) {
    try { execSync(`tmux kill-session -t "${tmuxName}" 2>/dev/null`, { stdio: 'ignore' }); } catch {}
    throw new Error('Failed to enter agent session');
  }

  return tmuxName;
}

async function waitForAgentsList(tmuxTarget) {
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const content = execSync(
        `tmux capture-pane -t "${tmuxTarget}" -p`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
      );
      if (content.includes('❯')) return true;
    } catch {}
  }
  return false;
}

async function navigateToAgent(tmuxTarget, agentName) {
  try {
    const content = execSync(
      `tmux capture-pane -t "${tmuxTarget}" -p`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
    );
    const lines = content.split('\n');

    const navItems = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('✻') || trimmed.startsWith('∙')) {
        // Row layout: "<marker> <label>  <detail>  <age>" — label is the first
        // column, separated from detail by 2+ spaces. Long labels are truncated
        // with a trailing '…'. Isolate the label for matching.
        const afterMarker = trimmed.replace(/^[✻∙]\s*/, '');
        const label = afterMarker.split(/\s{2,}/)[0].replace(/…+$/, '').trim();
        navItems.push({ type: 'session', text: trimmed, label });
      } else if (/^(Needs input|Working|Completed)$/.test(trimmed)) {
        navItems.push({ type: 'header', text: trimmed });
      }
    }

    let targetIdx = -1;
    const needle = (agentName || '').trim();
    if (needle) {
      for (let i = 0; i < navItems.length; i++) {
        const item = navItems[i];
        if (item.type !== 'session') continue;
        // Match in either direction: the TUI label may be a truncated prefix of
        // the full name/intent, or contain it.
        if (item.label && (needle.startsWith(item.label) || item.label.startsWith(needle)
          || item.text.includes(needle))) {
          targetIdx = i;
          break;
        }
      }
    }

    if (targetIdx < 0) return { ok: false, error: `Session "${needle || '(unnamed)'}" not found in agents list` };

    const firstSessionIdx = navItems.findIndex(n => n.type === 'session');
    const downs = targetIdx - firstSessionIdx;

    for (let i = 0; i < downs; i++) {
      spawnSync('tmux', ['send-keys', '-t', tmuxTarget, 'Down'], { stdio: 'ignore' });
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function waitForAgentPrompt(tmuxTarget, agentName) {
  let escaped = false;
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const content = execSync(
        `tmux capture-pane -t "${tmuxTarget}" -p`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
      );
      if (content.includes('← for agents') && content.includes('❯')) return true;
      // Blocked on AskUserQuestion: Right opens the option picker, not the prompt.
      // Decline it once so a free-text message can be typed.
      if (!escaped && content.includes('Esc to cancel')) {
        spawnSync('tmux', ['send-keys', '-t', tmuxTarget, 'Escape'], { stdio: 'ignore' });
        escaped = true;
      }
    } catch {}
  }
  return false;
}
