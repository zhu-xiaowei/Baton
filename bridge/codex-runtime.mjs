import fs from 'fs';
import path from 'path';
import { countJsonlLines } from './extract.mjs';
import { syncCodexMessages } from './codex-extract.mjs';
import { codexInteraction } from './codex-interaction.mjs';
import {
  discoverCodexHistory,
  discoverCodexSessions,
  findCodexSessionFile,
  getCodexRunningInfo,
  inspectCodexSession,
} from './codex-session.mjs';
import { readableProjectName } from './session.mjs';
import { defineRuntimeAdapter } from './runtime-adapter.mjs';
import {
  binaryVersion,
  existingDirectory,
  resolveCodexBin,
  resolveCodexHomes,
} from './runtime-capabilities.mjs';
import { projectHashCandidatesFromCwd, storageSessionId } from './session-identity.mjs';
import { projectCwdFromCwd } from './repository-identity.mjs';
import { CodexAppServerClient } from './codex-app-server.mjs';
import { trackAgentSession } from './agent-counts.mjs';

function publicSession(session) {
  const { _filePath, _lineCount, ...item } = session;
  return item;
}

async function deleteCodexHistory(sessionId, projectHash, context, ownsLiveSession) {
  // Metadata only, cached for this batch; never replay rollout message bodies.
  const files = await (context.codexHistoryFiles ||= discoverCodexHistory(context));
  const projects = new Map();
  const ids = new Set(sessionId ? [sessionId] : files
    .filter(({ cwd }) => {
      if (typeof cwd !== 'string' || !cwd) return false;
      if (!projects.has(cwd)) projects.set(cwd, projectHashCandidatesFromCwd(projectCwdFromCwd(cwd)));
      return projects.get(cwd).includes(projectHash);
    }).map((file) => file.id));
  // Only spawned children cascade. User-created forks remain independent.
  let changed;
  do {
    changed = false;
    for (const file of files) {
      if (file.parentId && ids.has(file.parentId) && !ids.has(file.id)) {
        ids.add(file.id);
        changed = true;
      }
    }
  } while (changed);
  if ([...ids].some(ownsLiveSession)) throw new Error('Close the active Codex sessions before deleting their history.');
  const ownedClients = !context.codexDeleteClients;
  const clients = context.codexDeleteClients ||= new Map();
  const tasks = new Map();
  for (const file of files.filter((file) => ids.has(file.id))) {
    const key = `${file.home}\0${file.id}`;
    if (!tasks.has(key)) tasks.set(key, { ...file, copies: [] });
    tasks.get(key).copies.push(file.filePath);
  }
  // A prior file-only deletion may have left this thread solely in Codex's DB.
  if (sessionId) {
    for (const home of context.codexHomes || resolveCodexHomes()) {
      const key = `${home}\0${sessionId}`;
      if (fs.existsSync(home) && !tasks.has(key)) tasks.set(key, { home, id: sessionId, copies: [] });
    }
  }
  const errors = [];
  async function remove(task) {
    try {
      if (!clients.has(task.home)) {
        const client = (context.createCodexClient || ((options) => new CodexAppServerClient(options)))({
          codexHomes: [task.home], env: { ...process.env, CODEX_HOME: task.home }, requestTimeout: 10000,
        });
        clients.set(task.home, { client, ready: Promise.resolve().then(() => client.start?.()).catch(() => false) });
      }
      const entry = clients.get(task.home);
      if (await entry.ready === false) throw new Error('Codex app-server unavailable');
      await entry.client.request('thread/delete', { threadId: task.id });
    } catch (error) {
      errors.push(`Codex database deletion was not confirmed for ${task.id}: ${error.message}`);
      // A native refusal (for example, an active turn) must not be bypassed by unlinking.
      if (error.code != null && error.code !== -32601) return;
      // Do not spend another timeout on every batch after the server disconnects.
      const entry = clients.get(task.home);
      if (entry && /timed out|not writable|closed|exited|unavailable/i.test(error.message)) {
        entry.ready = Promise.resolve(false);
      }
    }
    for (const filePath of task.copies) {
      try { await fs.promises.rm(filePath, { force: true }); }
      catch (error) { errors.push(error.message); }
    }
    context.watermarks?.delete(storageSessionId('codex', task.id));
  }
  try {
    const pending = [...tasks.values()];
    for (let i = 0; i < pending.length; i += 8) await Promise.all(pending.slice(i, i + 8).map(remove));
  } finally {
    if (ownedClients) {
      await Promise.all([...clients.values()].map(({ client }) => client.stop().catch(() => {})));
      delete context.codexDeleteClients;
    }
  }
  if (errors.length) throw new Error(errors.join('; '));
  return true;
}

export const codexRuntime = defineRuntimeAdapter({
  runtime: 'codex',
  displayName: 'Codex',
  features: {
    create: true,
    send: true,
    interrupt: true,
    deleteHistory: true,
    statusPolling: true,
  },
  interaction: codexInteraction,

  discover: discoverCodexSessions,
  detectCapability(options = {}) {
    const homes = options.codexHomes || resolveCodexHomes();
    const binary = options.codexBin === undefined ? resolveCodexBin() : options.codexBin;
    const historyAvailable = homes.some((home) => existingDirectory(path.join(home, 'sessions')));
    return {
      installed: !!binary,
      historyAvailable,
      canRead: historyAvailable,
      canCreate: !!binary,
      canSend: !!binary,
      version: options.skipVersions ? '' : binaryVersion(binary),
    };
  },
  findSessionFile: findCodexSessionFile,
  deleteSessionHistory(nativeSessionId, context = {}) {
    return !!nativeSessionId && deleteCodexHistory(nativeSessionId, '', context, (id) => this.ownsLiveSession(id, context));
  },
  deleteProjectHistory(projectHash, context = {}) {
    return !!projectHash && deleteCodexHistory('', projectHash, context, (id) => this.ownsLiveSession(id, context));
  },
  ownsLiveSession(nativeSessionId) {
    return codexInteraction.owns(nativeSessionId);
  },

  shouldSkipInitial(session) {
    // Internal Guardian/compact/review threads are catalogued only so a full
    // sync can overwrite older rows that were mistakenly exposed as agents.
    return session.threadKind === 'internal';
  },

  baselineToEnd(session, context) {
    const lineCount = session._lineCount ?? countJsonlLines(session._filePath);
    context.watermarks.set(context.storageSessionId, lineCount);
  },

  syncInitialMessages(session, context) {
    return syncCodexMessages(
      session._filePath,
      session.nativeSessionId,
      context.storageSessionId,
      {
        watermarks: context.watermarks,
        uploader: context.uploader,
      },
    );
  },

  syncAllMessages(session, context) {
    return syncCodexMessages(
      session._filePath,
      session.nativeSessionId,
      context.storageSessionId,
      {
        startLine: 0,
        watermarks: context.watermarks,
        uploader: context.uploader,
      },
    );
  },

  createStatusContext(context = {}) {
    return {
      runningInfo: getCodexRunningInfo(),
      lastKnownStatus: context.lastKnownStatus,
    };
  },

  inspectActiveSession(active, context) {
    const nativeSessionId = active.nativeSessionId || active.sessionId;
    const sessionId = storageSessionId('codex', nativeSessionId);
    const filePath = (context.findSessionFile || findCodexSessionFile)(nativeSessionId);
    let session;
    if (!filePath || !fs.existsSync(filePath)) {
      session = {
        id: nativeSessionId,
        nativeSessionId,
        runtime: 'codex',
        project: active.projectHash || '',
        projectName: active.projectName || active.projectHash || '',
        lastActive: active.lastActive || new Date().toISOString(),
        size: 0,
        preview: active.preview || '',
        model: '',
        status: 'completed',
      };
    } else {
      session = inspectCodexSession(nativeSessionId, {
        filePath,
        runningInfo: context.runningInfo,
        runtimeOwned: codexInteraction.owns(nativeSessionId),
      });
      if (!session) return null;
    }
    // A deleted worktree changes what projectHashFromCwd can resolve. Settle
    // the active row under its existing key instead of creating a second row.
    if (active.projectHash && session.project !== active.projectHash) {
      session.project = active.projectHash;
      session.projectName = readableProjectName(active.projectHash);
    }
    if (session.status === active.status) return null;

    context.lastKnownStatus.set(sessionId, session.status);
    return {
      session: publicSession(session),
      statusDelta: {
        deviceName: active.deviceName,
        projectHash: session.project,
        projectName: session.projectName,
        from: active.status,
        to: session.status,
        lastActive: session.lastActive,
      },
    };
  },

  async updateSessionStatus(config, nativeSessionId, filePath, _projectHash, newStatus, detail, context) {
    const sessionId = storageSessionId('codex', nativeSessionId);
    const previousStatus = context.lastKnownStatus.get(sessionId);
    if ((previousStatus === newStatus && newStatus !== 'needs_input')
      || !filePath || !fs.existsSync(filePath)) return;
    const session = inspectCodexSession(nativeSessionId, {
      filePath,
      runningInfo: getCodexRunningInfo(),
    });
    if (!session) return;
    session.status = newStatus;
    session.agentDetail = newStatus === 'needs_input' ? detail || '' : '';
    const statusChanged = previousStatus !== newStatus;
    const agentCountUpdates = trackAgentSession(session);
    await context.postFn('/api/bridge/sync-sessions', {
      deviceName: config.deviceName,
      os: process.platform,
      sessions: [publicSession(session)],
      ...(agentCountUpdates.length ? { agentCountUpdates } : {}),
      ...(statusChanged && !session.parentSessionId ? {
        statusDeltas: [{
          deviceName: config.deviceName,
          projectHash: session.project,
          projectName: session.projectName,
          from: previousStatus || 'completed',
          to: newStatus,
          lastActive: session.lastActive,
        }],
      } : {}),
    });
    context.lastKnownStatus.set(sessionId, newStatus);
  },
});
