import { codexArchives } from './codex-archive.mjs';
import { codexInteraction } from './codex-interaction.mjs';
import { scanCodexRollout } from './codex-session.mjs';
import { projectHashFromCwd, storageSessionId } from './session-identity.mjs';
import { CLAUDE_PROJECTS } from './config.mjs';
import { postRequired } from './http.mjs';
import { safeCodexArchivePath } from './codex-archive-index.mjs';
import { codexSessionStatus } from './codex-status.mjs';
import { trackAgentSession } from './agent-counts.mjs';

export function createCodexArchiveSync(config, postFn = postRequired) {
  return async (records) => {
    const acknowledged = [];
    const conflicts = [];
    const prepared = [];
    for (const record of records) {
      let session;
      try {
        const filePath = safeCodexArchivePath(record.home, record.path);
        session = filePath ? scanCodexRollout(filePath, { nativeSessionId: record.id }).session : null;
      } catch {}
      if (!session && record.cwd && record.preview) {
        session = {
          id: record.id, nativeSessionId: record.id, runtime: 'codex',
          project: projectHashFromCwd(record.cwd, CLAUDE_PROJECTS),
          projectName: record.cwd, preview: record.preview,
          lastActive: record.lastActive || new Date(record.archiveVersion).toISOString(),
          ...codexSessionStatus(record.id),
          archiveState: record.archiveState, archiveVersion: record.archiveVersion,
          ...(record.parentThreadId ? {
            parentSessionId: storageSessionId('codex', record.parentThreadId),
            threadKind: 'subagent', isAgent: true,
          } : {}),
        };
      }
      if (!session) continue;
      prepared.push({ record, session });
    }
    const summaries = new Map();
    for (const { session } of [...prepared].sort((a, b) => !!a.session.parentSessionId - !!b.session.parentSessionId)) {
      for (const update of trackAgentSession(session)) summaries.set(update.sessionId, update);
    }
    for (const { session } of prepared) {
      if (!session.parentSessionId) trackAgentSession(session);
    }
    for (let offset = 0; offset < prepared.length; offset += 100) {
      const batch = prepared.slice(offset, offset + 100);
      const sessions = batch.map(({ session }) => {
        const { _filePath, _lineCount, archiveState, archiveVersion, ...metadata } = session;
        return metadata;
      });
      const observations = batch.map(({ record, session }) => ({
        sessionId: storageSessionId('codex', record.id),
        projectHash: session.project,
        archiveState: record.archiveState,
        archiveVersion: record.archiveVersion,
      }));
      await postFn('/api/bridge/sync-sessions', {
        deviceName: config.deviceName, os: process.platform,
        catalogComplete: false, sessions,
        ...(offset + 100 >= prepared.length ? { agentCountUpdates: [...summaries.values()] } : {}),
      });
      const response = await postFn('/api/bridge/sync-archives', { deviceName: config.deviceName, observations });
      const result = await response.json();
      if (!Array.isArray(result.acknowledged)) throw new Error('Server does not acknowledge archive observations.');
      for (const { record } of batch) {
        const sessionId = storageSessionId('codex', record.id);
        if (result.acknowledged.some((item) => item.sessionId === sessionId
          && item.archiveState === record.archiveState && item.archiveVersion === record.archiveVersion)) {
          acknowledged.push(`${record.home}:${record.id}`);
        }
        const conflict = result.ignored?.find((item) => item.sessionId === sessionId);
        if (conflict) conflicts.push({ home: record.home, id: record.id, version: conflict.currentArchiveVersion });
      }
    }
    return { acknowledged, conflicts };
  };
}

export async function startCodexArchives(config) {
  codexArchives.isBusy = (id) => codexInteraction.isBusy(id);
  codexArchives.busySessionIds = () => [...codexInteraction.sessions.keys()].filter((id) => codexInteraction.isBusy(id));
  codexArchives.sync = createCodexArchiveSync(config);
  await codexArchives.start();
}
