import fs from 'fs';
import path from 'path';
import { countJsonlLines } from './extract.mjs';
import { syncCodexMessages } from './codex-extract.mjs';
import {
  discoverCodexSessions,
  findCodexSessionFile,
  getCodexRunningInfo,
  scanCodexRollout,
} from './codex-session.mjs';
import { defineRuntimeAdapter } from './runtime-adapter.mjs';
import {
  binaryVersion,
  existingDirectory,
  resolveCodexBin,
  resolveCodexHomes,
} from './runtime-capabilities.mjs';
import { storageSessionId } from './session-identity.mjs';

function publicSession(session) {
  const { _filePath, _lineCount, ...item } = session;
  return item;
}

export const codexRuntime = defineRuntimeAdapter({
  runtime: 'codex',
  displayName: 'Codex',
  features: {
    statusPolling: true,
  },

  discover: discoverCodexSessions,
  detectCapability(options = {}) {
    const homes = options.codexHomes || resolveCodexHomes();
    const binary = options.codexBin === undefined ? resolveCodexBin() : options.codexBin;
    const historyAvailable = homes.some((home) => existingDirectory(path.join(home, 'sessions')));
    return {
      installed: !!binary,
      historyAvailable,
      canRead: historyAvailable,
      // The rollout watcher is read-only until the app-server path is implemented.
      canCreate: false,
      canSend: false,
      version: options.skipVersions ? '' : binaryVersion(binary),
    };
  },
  findSessionFile: findCodexSessionFile,

  shouldSkipInitial() {
    // Startup closes the gap before the watcher attaches.
    return false;
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
      session = scanCodexRollout(filePath, {
        nativeSessionId,
        runningInfo: context.runningInfo,
      }).session;
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

  async updateSessionStatus(config, nativeSessionId, filePath, _projectHash, newStatus, _detail, context) {
    const sessionId = storageSessionId('codex', nativeSessionId);
    const previousStatus = context.lastKnownStatus.get(sessionId);
    if (previousStatus === newStatus || !filePath || !fs.existsSync(filePath)) return;
    const session = scanCodexRollout(filePath, {
      nativeSessionId,
      runningInfo: getCodexRunningInfo(),
    }).session;
    if (!session) return;
    session.status = newStatus;
    await context.postFn('/api/bridge/sync-sessions', {
      deviceName: config.deviceName,
      os: process.platform,
      sessions: [publicSession(session)],
      statusDeltas: [{
        deviceName: config.deviceName,
        projectHash: session.project,
        projectName: session.projectName,
        from: previousStatus || 'completed',
        to: newStatus,
        lastActive: session.lastActive,
      }],
    });
    context.lastKnownStatus.set(sessionId, newStatus);
  },
});
