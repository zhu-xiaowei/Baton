import fs from 'fs';
import path from 'path';
import { CLAUDE_PROJECTS } from './config.mjs';
import { countJsonlLines } from './extract.mjs';
import {
  findSessionFile,
  getDaemonSessions,
  getDaemonRunningSessionIds,
  getRunningInfo,
  getSessionMetadata,
  getSessionStatus,
  normalizeProjectHash,
  previewText,
  readClaudeFirstPrompts,
  readableProjectName,
} from './session.mjs';
import { defineRuntimeAdapter } from './runtime-adapter.mjs';
import {
  discoverClaudeSubagents,
  findClaudeSubagentFile,
  parseClaudeSubagentSessionId,
} from './claude-subagent.mjs';
import { trackAgentSession } from './agent-counts.mjs';

function findClaudeSessionFile(nativeSessionId) {
  return findClaudeSubagentFile(nativeSessionId) || findSessionFile(nativeSessionId);
}

export function discoverClaudeSessions(options = {}) {
  const projectsRoot = options.claudeProjectsRoot || CLAUDE_PROJECTS;
  const historyPath = options.claudeHistoryPath
    || path.join(path.dirname(projectsRoot), 'history.jsonl');
  let firstPrompts = new Map();
  try {
    firstPrompts = readClaudeFirstPrompts(historyPath);
  } catch {}
  const runningInfo = options.runningInfo || getRunningInfo();
  const sessions = [];
  const errors = [];
  let projects = [];
  let fileCount = 0;

  try {
    projects = fs.existsSync(projectsRoot) ? fs.readdirSync(projectsRoot) : [];
  } catch (error) {
    errors.push({ path: projectsRoot, error: error.message });
  }

  for (const project of projects) {
    const projectDir = path.join(projectsRoot, project);
    let jsonlFiles;
    try {
      if (!fs.statSync(projectDir).isDirectory()) continue;
      jsonlFiles = fs.readdirSync(projectDir)
        .filter((file) => file.endsWith('.jsonl') && !file.startsWith('.'));
    } catch (error) {
      errors.push({ path: projectDir, error: error.message });
      continue;
    }

    for (const file of jsonlFiles) {
      const filePath = path.join(projectDir, file);
      fileCount++;
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch (error) {
        errors.push({ path: filePath, error: error.message });
        continue;
      }
      if (stat.size === 0) continue;

      const nativeSessionId = file.slice(0, -'.jsonl'.length);
      const metadata = getSessionMetadata(filePath, {
        firstPrompt: firstPrompts.get(nativeSessionId),
      });
      const projectHash = normalizeProjectHash(project);
      const session = {
        id: nativeSessionId,
        nativeSessionId,
        runtime: 'claude',
        project: projectHash,
        projectName: readableProjectName(projectHash),
        lastActive: stat.mtime.toISOString(),
        size: stat.size,
        preview: metadata.preview || 'New session',
        model: metadata.model,
        status: getSessionStatus(nativeSessionId, filePath, runningInfo),
        _filePath: filePath,
        _lineCount: metadata.lineCount,
      };
      const children = discoverClaudeSubagents(projectDir, session, { now: options.now });
      if (!metadata.preview && !children.length) continue;
      if (!metadata.preview) session._provisional = true;
      sessions.push(session, ...children);
    }
  }

  const daemonMeta = options.daemonMeta || getDaemonSessions();
  for (const session of sessions) {
    const daemon = daemonMeta.get(session.nativeSessionId);
    if (!daemon) continue;
    session.isAgent = true;
    session.agentName = daemon.agentName;
    session.agentDetail = daemon.agentDetail;
    session.status = daemon.status;
  }

  return {
    sessions,
    complete: errors.length === 0,
    diagnostics: {
      files: fileCount,
      errors,
      malformedLines: 0,
      skipped: {},
    },
  };
}

// The notifier keeps a root's child counts when they are omitted, so a settling
// root re-derives them from disk and carries its children along.
function refreshClaudeSubagents(session, filePath) {
  if (parseClaudeSubagentSessionId(session.nativeSessionId)) return [];
  const children = filePath ? discoverClaudeSubagents(path.dirname(filePath), session) : [];
  for (const child of children) trackAgentSession(child);
  trackAgentSession(session);
  return children;
}

function insideRoot(target, root) {
  const resolved = path.resolve(target);
  const resolvedRoot = path.resolve(root);
  return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
}

function removeInsideRoot(target, root) {
  if (!insideRoot(target, root)) return false;
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function removeClaudeSessionHistoryFiles(
  filePath,
  nativeSessionId,
  context = {},
) {
  const projectsRoot = context.projectsRoot || CLAUDE_PROJECTS;
  const sessionDir = filePath.endsWith('.jsonl')
    ? filePath.slice(0, -'.jsonl'.length)
    : '';
  const fileDeleted = removeInsideRoot(filePath, projectsRoot);
  const childrenDeleted = !sessionDir
    || removeInsideRoot(sessionDir, projectsRoot);
  if (fileDeleted && childrenDeleted && context.watermarks) {
    const childPrefix = `${nativeSessionId}:subagent:`;
    for (const sessionId of Array.from(context.watermarks.keys())) {
      if (sessionId === nativeSessionId || sessionId.startsWith(childPrefix)) {
        context.watermarks.delete(sessionId);
      }
    }
  }
  return fileDeleted && childrenDeleted;
}

function claudeHistoryDirectories(projectsRoot, projectHash, context) {
  const directories = context.claudeHistoryDirectories ||= !fs.existsSync(projectsRoot) ? []
    : fs.readdirSync(projectsRoot).filter((name) =>
      fs.lstatSync(path.join(projectsRoot, name)).isDirectory(),
    ).map((name) => path.join(projectsRoot, name));
  return projectHash ? directories.filter((dir) =>
    normalizeProjectHash(path.basename(dir)) === normalizeProjectHash(projectHash),
  ) : directories;
}

function validHistoryKey(value) {
  return typeof value === 'string' && !!value
    && value !== '.' && !value.includes('..') && !/[\\/\0]/.test(value);
}

export const claudeRuntime = defineRuntimeAdapter({
  runtime: 'claude',
  displayName: 'Claude',
  features: {
    create: true,
    send: true,
    interrupt: true,
    deleteHistory: true,
    statusPolling: true,
  },

  discover: discoverClaudeSessions,
  findSessionFile: findClaudeSessionFile,

  baselineToEnd(session, context) {
    const lineCount = session._lineCount ?? countJsonlLines(session._filePath);
    context.watermarks.set(context.storageSessionId, lineCount);
  },

  deleteSessionHistory(nativeSessionId, context = {}) {
    if (!validHistoryKey(nativeSessionId) || parseClaudeSubagentSessionId(nativeSessionId)) return false;
    if (this.ownsLiveSession(nativeSessionId, context)) throw new Error('Close the active Claude session before deleting its history.');
    const projectsRoot = context.projectsRoot || CLAUDE_PROJECTS;
    let ok = true;
    // The same session can have copies in the main project and its worktrees.
    for (const dir of claudeHistoryDirectories(projectsRoot, '', context)) {
      if (!removeClaudeSessionHistoryFiles(
        path.join(dir, `${nativeSessionId}.jsonl`), nativeSessionId, { ...context, projectsRoot },
      )) ok = false;
    }
    return ok;
  },

  deleteProjectHistory(projectHash, context = {}) {
    if (!validHistoryKey(projectHash)) return false;
    const projectsRoot = context.projectsRoot || CLAUDE_PROJECTS;
    const directories = claudeHistoryDirectories(projectsRoot, projectHash, context);
    for (const dir of directories) {
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir)) {
        if (file.endsWith('.jsonl') && this.ownsLiveSession(file.slice(0, -6), context)) {
          throw new Error('Close the active Claude sessions before deleting this project.');
        }
      }
    }
    let ok = true;
    for (const dir of directories) {
      if (!removeInsideRoot(dir, projectsRoot)) ok = false;
    }
    return ok;
  },

  ownsLiveSession(nativeSessionId, context = {}) {
    return !!context.pool?.owns(nativeSessionId);
  },

  createStatusContext(context = {}) {
    return {
      runningInfo: getRunningInfo(),
      daemonMeta: getDaemonSessions(),
      daemonRunning: getDaemonRunningSessionIds(),
      poolOwns: context.poolOwns || (() => false),
      poolAwaitsAgents: context.poolAwaitsAgents,
      findSessionFile: context.findSessionFile || findSessionFile,
    };
  },

  inspectActiveSession(active, context) {
    const nativeSessionId = active.nativeSessionId || active.sessionId;
    const filePath = (context.findSessionFile || findClaudeSessionFile)(nativeSessionId);
    const gone = !filePath || !fs.existsSync(filePath);
    const daemon = context.daemonMeta.get(nativeSessionId);
    if (!gone && ((context.daemonRunning || new Set()).has(nativeSessionId) || context.poolOwns(nativeSessionId))) {
      return null;
    }
    const newStatus = gone
      ? 'completed'
      : getSessionStatus(nativeSessionId, filePath, context.runningInfo);
    if (newStatus === active.status) return null;

    const projectHash = normalizeProjectHash(active.projectHash || '');
    const projectName = readableProjectName(projectHash);
    const stat = gone ? null : fs.statSync(filePath);
    const metadata = gone ? null : getSessionMetadata(filePath);
    const lastActive = gone ? active.lastActive : stat.mtime.toISOString();
    const session = {
      id: nativeSessionId,
      nativeSessionId,
      runtime: 'claude',
      project: projectHash,
      projectName,
      lastActive,
      size: stat?.size || 0,
      preview: metadata?.preview || active.preview || '',
      model: metadata?.model || '',
      status: newStatus,
    };
    if (daemon) {
      session.isAgent = true;
      session.agentName = daemon.agentName;
      session.agentDetail = newStatus === 'needs_input' ? daemon.agentDetail || '' : '';
    }
    // A terminal record reads busy while agents run, so newStatus is running there.
    if (newStatus === 'completed' && !gone && context.poolAwaitsAgents?.(nativeSessionId)) session.backgroundAgents = true;
    const children = refreshClaudeSubagents(session, gone ? '' : filePath);
    return { session, extraSessions: children };
  },

  async updateSessionStatus(config, nativeSessionId, filePath, projectHash, newStatus, detail, context) {
    projectHash = normalizeProjectHash(projectHash);
    let stat;
    try { stat = fs.statSync(filePath); } catch { return; }
    const lastActive = stat.mtime.toISOString();
    const projectName = readableProjectName(projectHash);
    const daemon = (context.daemonMeta || getDaemonSessions()).get(nativeSessionId);
    const metadata = getSessionMetadata(filePath);
    const session = {
      id: nativeSessionId,
      nativeSessionId,
      runtime: 'claude',
      project: projectHash,
      projectName,
      lastActive,
      size: stat.size,
      // A forked Skill writes no user row until it finishes; show the sent prompt meanwhile.
      preview: metadata.preview || previewText(context.sentPrompt),
      model: metadata.model,
      status: newStatus,
    };
    if (daemon) {
      session.isAgent = true;
      session.agentName = daemon.agentName;
    }
    session.agentDetail = newStatus === 'needs_input'
      ? (detail !== undefined ? detail : daemon?.agentDetail || '')
      : '';
    // CC reports back when its background agents end; that turn alerts instead.
    if (context.backgroundAgents) session.backgroundAgents = true;
    trackAgentSession(session);
    context.report(config, [session]);
  },
});
