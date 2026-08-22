import fs from 'fs';
import path from 'path';
import { countJsonlLines } from './extract.mjs';
import { syncCodexMessages } from './codex-extract.mjs';
import { codexInteraction } from './codex-interaction.mjs';
import {
  discoverCodexSessions,
  findCodexSessionFile,
  getCodexRunningInfo,
  inspectCodexSession,
} from './codex-session.mjs';
import { defineRuntimeAdapter } from './runtime-adapter.mjs';
import {
  binaryVersion,
  existingDirectory,
  resolveCodexBin,
  resolveCodexHomes,
} from './runtime-capabilities.mjs';
import { storageSessionId } from './session-identity.mjs';
import { trackAgentSession } from './agent-counts.mjs';

function publicSession(session) {
  const { _filePath, _lineCount, ...item } = session;
  return item;
}

export const codexRuntime = defineRuntimeAdapter({
  runtime: 'codex',
  displayName: 'Codex',
  features: {
    create: true,
    send: true,
    interrupt: true,
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
    const filePath = findCodexSessionFile(nativeSessionId);
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
      });
      if (!session) return null;
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
