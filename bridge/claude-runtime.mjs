import fs from 'fs';
import path from 'path';
import { CLAUDE_PROJECTS } from './config.mjs';
import {
  extractClaudeMessages,
  countJsonlLines,
} from './extract.mjs';
import {
  findSessionFile,
  getDaemonSessions,
  getDaemonRunningSessionIds,
  getRunningInfo,
  getSessionMetadata,
  getSessionStatus,
  normalizeProjectHash,
  readClaudeFirstPrompts,
  readableProjectName,
} from './session.mjs';
import { defineRuntimeAdapter } from './runtime-adapter.mjs';
import {
  binaryVersion,
  existingDirectory,
  resolveClaudeBinForCapability,
} from './runtime-capabilities.mjs';
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
      const children = discoverClaudeSubagents(projectDir, session, {
        now: options.now,
        parentRunning: runningInfo.sessions.has(nativeSessionId)
          || (runningInfo.projects.has(project) && runningInfo.sessions.size === 0),
      });
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

async function syncClaudeMessages(session, context, startLine) {
  const extracted = await extractClaudeMessages(
    session._filePath,
    session.nativeSessionId,
    {
      startLine,
      watermarks: context.watermarks,
    },
  );
  if (extracted.messages.length > 0 || startLine === 0) {
    await context.uploader(context.storageSessionId, extracted.messages, { historyComplete: startLine === 0 });
  }
  context.watermarks.set(context.storageSessionId, extracted.nextLine);
  return extracted;
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
  detectCapability(options = {}) {
    const binary = options.claudeBin === undefined
      ? resolveClaudeBinForCapability()
      : options.claudeBin;
    const historyAvailable = existingDirectory(options.claudeProjects || CLAUDE_PROJECTS);
    return {
      installed: !!binary,
      historyAvailable,
      canRead: historyAvailable,
      canCreate: !!binary,
      canSend: !!binary,
      version: options.skipVersions ? '' : binaryVersion(binary),
    };
  },
  findSessionFile: findClaudeSessionFile,

  shouldSkipInitial(session, context) {
    return !session._provisional && context.watermarks.has(context.storageSessionId);
  },

  baselineToEnd(session, context) {
    const lineCount = session._lineCount ?? countJsonlLines(session._filePath);
    context.watermarks.set(context.storageSessionId, lineCount);
  },

  syncInitialMessages(session, context) {
    const startLine = session._provisional ? 0 : (context.watermarks.get(context.storageSessionId) ?? 0);
    return syncClaudeMessages(session, context, startLine);
  },

  syncAllMessages(session, context) {
    return syncClaudeMessages(session, context, 0);
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
      lastKnownStatus: context.lastKnownStatus,
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
    context.lastKnownStatus.set(nativeSessionId, newStatus);
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
    return {
      session,
      statusDelta: {
        deviceName: active.deviceName,
        projectHash,
        projectName,
        from: active.status,
        to: newStatus,
        lastActive,
      },
    };
  },

  async updateSessionStatus(config, nativeSessionId, filePath, projectHash, newStatus, detail, context) {
    projectHash = normalizeProjectHash(projectHash);
    const previousStatus = context.lastKnownStatus.get(nativeSessionId);
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
      preview: metadata.preview,
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
    trackAgentSession(session);
    await context.postFn('/api/bridge/sync-sessions', {
      deviceName: config.deviceName,
      os: process.platform,
      sessions: [session],
      statusDeltas: [{
        deviceName: config.deviceName,
        projectHash,
        projectName,
        from: context.isNew && previousStatus === undefined ? 'new' : previousStatus || 'completed',
        to: newStatus,
        lastActive,
      }],
    });
    context.lastKnownStatus.set(nativeSessionId, newStatus);
  },
});
