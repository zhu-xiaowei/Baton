import path from 'path';
import { countJsonlLines } from './extract.mjs';
import { syncCodexMessages } from './codex-extract.mjs';
import { discoverCodexSessions, findCodexSessionFile } from './codex-session.mjs';
import { defineRuntimeAdapter } from './runtime-adapter.mjs';
import {
  binaryVersion,
  existingDirectory,
  resolveCodexBin,
  resolveCodexHomes,
} from './runtime-capabilities.mjs';

export const codexRuntime = defineRuntimeAdapter({
  runtime: 'codex',
  displayName: 'Codex',

  discover: discoverCodexSessions,
  detectCapability(options = {}) {
    const homes = options.codexHomes || resolveCodexHomes();
    const binary = options.codexBin === undefined ? resolveCodexBin() : options.codexBin;
    const historyAvailable = homes.some((home) => existingDirectory(path.join(home, 'sessions')));
    return {
      installed: !!binary,
      historyAvailable,
      canRead: historyAvailable,
      // Phase 1 remains read-only until the app-server path is implemented.
      canCreate: false,
      canSend: false,
      version: options.skipVersions ? '' : binaryVersion(binary),
    };
  },
  findSessionFile: findCodexSessionFile,

  shouldSkipInitial() {
    // Without a Codex watcher, startup consumes all lines after the watermark.
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
});
