// OpenCode ≥ 2.2: catalog and history from the read-only opencode.db, live pushes on its commits,
// interaction through the user's own background service (service.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { defineRuntimeAdapter } from '../../runtime-adapter.mjs';
import { defineRuntimeWatcher } from '../../watcher-adapter.mjs';
import { liveMessagePushed } from '../../live-message-registry.mjs';
import { batonSessions, localIdleSec } from '../../presence.mjs';
import { sessionIndex } from '../../session-index.mjs';
import { previewText } from '../../session.mjs';
import { storageSessionId } from '../../session-identity.mjs';
import { lastKnownStatus, reportSessions } from '../../sync.mjs';
import { publishMessages } from '../../ws.mjs';
import { DB_FILE, displayLabel } from './extract.mjs';
import history, { db, OpenCodeReader } from './history.mjs';
import { interaction, opencodeProcesses, service } from './service.mjs';

db.all('SELECT 1 FROM session_v2 LIMIT 0'); // OpenCode 1.x has no v2 tables
const MARK = 'max(time_updated, coalesce(time_busy, 0), coalesce(time_idle, 0), coalesce(time_suspended, 0), coalesce(time_archived, 0))';
const file = (id) => `rows:opencode:${id}`;
const record = (id) => sessionIndex.records.get(file(id));

const marks = new Map(); // id → change mark delivered
const changed = new Set(); // ids upserted since the watcher last looked
const catalog = {
  kind: 'rows',
  watchPaths: () => [DB_FILE, `${DB_FILE}-wal`],
  // PRAGMA data_version says whether anyone committed; then only rows whose mark moved are read.
  refresh(cursor) {
    const version = db.dataVersion();
    if (cursor?.version === version) return { cursor };
    const rows = db.all(`SELECT id, parent_id, directory, title, model, time_updated, time_busy, time_idle, time_archived, ${MARK} AS mark
      FROM session_v2 WHERE ${MARK} >= ?`, [cursor?.mark ?? -1]);
    const upserts = [];
    const deletes = [];
    for (const r of rows) {
      if (marks.get(r.id) === r.mark) continue;
      marks.set(r.id, r.mark);
      changed.add(r.id);
      if (r.time_archived) { deletes.push(r.id); continue; }
      let model = '';
      try { model = JSON.parse(r.model || 'null')?.id || ''; } catch {}
      upserts.push({ id: r.id, ms: r.time_updated, parent: r.parent_id || '', directory: r.directory, title: r.title || '', model,
        busy: r.time_busy || 0, idle: r.time_idle || 0 });
    }
    // Deleted rows leave no mark: the count tells, then the ids.
    if (db.all('SELECT count(*) AS n FROM session_v2')[0].n !== marks.size) {
      const present = new Set(db.all('SELECT id FROM session_v2').map((r) => r.id));
      for (const id of marks.keys()) if (!present.has(id)) { marks.delete(id); deletes.push(id); }
    }
    return { upserts, deletes, cursor: { version, mark: Math.max(cursor?.mark ?? -1, ...rows.map((r) => r.mark)) } };
  },
  view(rec, index) {
    const s = rec.state;
    const project = index.cwdProject(s.directory);
    // Until OpenCode names a session Baton created, its prompt stands in.
    const preview = s.title ? displayLabel(s.title) : previewText(index.sentPrompts.get(rec.id)) || displayLabel('', s.parent);
    return project ? { project, preview, parent: s.parent || undefined, visible: true, agentCount: 0 } : null;
  },
  running: () => opencodeProcesses(),
  // Busy with no opencode process left is an orphaned claim: the next `service start` resumes it.
  status(rec, procs = []) {
    if (interaction.pending(rec.id)) return 'needs_input';
    return rec.state.busy > rec.state.idle && procs.length ? 'running' : 'completed';
  },
};

function sessionRow(rec, status, detail = '') {
  const { project = '', preview = '' } = catalog.view(rec, sessionIndex) || {};
  return { id: rec.id, nativeSessionId: rec.id, runtime: 'opencode', project, projectName: sessionIndex.projectPath(project),
    preview, model: rec.state.model, size: 0, lastActive: new Date(rec.ms).toISOString(),
    status, ...(status === 'needs_input' ? { agentDetail: detail } : {}) };
}

// Each commit: the catalog, root status changes, and the rows other clients wrote (Baton's own live
// rows were pushed already). New rows are found through time_created (indexed); busy sessions are
// re-read for rows updated in place.
const watcher = defineRuntimeWatcher({
  runtime: 'opencode',
  start(config) {
    const readers = new Map();
    let since = Date.now();
    let busy = null;
    let again = false;
    const pass = async () => {
      await sessionIndex.touch(DB_FILE);
      const procs = opencodeProcesses();
      for (const id of changed) {
        const rec = record(id);
        if (rec && interaction.owns(id)) continue; // reported by the turn; looked at again once it ends
        changed.delete(id);
        if (!rec || rec.state.parent) continue;
        const sessionId = storageSessionId('opencode', id);
        const status = catalog.status(rec, procs);
        const previous = lastKnownStatus.get(sessionId);
        if (status === previous || (!previous && status === 'completed')) continue;
        const row = sessionRow(rec, status);
        if (previous === 'running' && !batonSessions.has(id)) row.localIdleSec = await localIdleSec();
        reportSessions(config, [row]);
      }
      const ids = new Set(db.all('SELECT DISTINCT session_id AS id FROM session_message WHERE time_created >= ?', [since]).map((r) => r.id));
      for (const rec of sessionIndex.records.values()) if (rec.runtime === 'opencode' && rec.state.busy > rec.state.idle) ids.add(rec.id);
      const floor = since;
      since = Date.now() - 1000;
      for (const id of ids) {
        const reader = readers.get(id) || new OpenCodeReader(id);
        const fresh = !readers.delete(id);
        readers.set(id, reader);
        if (readers.size > 32) readers.delete(readers.keys().next().value);
        if (!reader.update() || interaction.owns(id)) continue;
        const { ids: all, changed: rowIds, marks: rowMarks } = reader.index;
        const wanted = new Set(rowIds.filter((rid) => !fresh || rowMarks.get(rid) >= floor));
        if (!wanted.size) continue;
        const rows = await reader.rows(Math.min(...[...wanted].map((rid) => all.indexOf(rid))), all.length);
        publishMessages(storageSessionId('opencode', id), rows.filter((row) => wanted.has(row.uuid.split('#')[0])
          && !liveMessagePushed('opencode', row.uuid)));
      }
    };
    const kick = () => {
      if (busy) { again = true; return; }
      busy = pass().catch((error) => console.error(`[watcher] OpenCode: ${error.message}`)).finally(() => {
        busy = null;
        if (again) { again = false; kick(); }
      });
    };
    interaction.settled = kick;
    const names = new Set(catalog.watchPaths().map((p) => path.basename(p)));
    return fs.watch(path.dirname(DB_FILE), (_type, name) => { if (names.has(name)) kick(); });
  },
});

export default defineRuntimeAdapter({
  ...history,
  displayName: 'OpenCode',
  features: { create: true, send: true, interrupt: true, deleteHistory: true, statusPolling: true },
  catalog,
  watcher,
  interaction,
  discover: () => ({ sessions: [] }),
  findSessionFile: (id) => (record(id) ? file(id) : null),
  baselineToEnd() {},
  async updateSessionStatus(config, id, _file, _project, status, detail, context) {
    const rec = record(id);
    if (rec) context.report(config, [sessionRow(rec, status, detail)]);
  },
  createStatusContext: () => ({ procs: opencodeProcesses() }),
  inspectActiveSession(active, context) {
    const rec = record(active.nativeSessionId);
    const status = rec ? catalog.status(rec, context.procs) : 'completed';
    return rec && status !== active.status ? { session: sessionRow(rec, status) } : null;
  },
  rename: (id, title) => service.api('PATCH', `/api/session/${id}`, { title }),
  // OpenCode deletes children with their root; it would also delete a busy session (ws.mjs guards).
  deleteSessionHistory: (id) => service.api('DELETE', `/api/session/${id}`).then(() => true),
  async deleteProjectHistory(projectHash) {
    for (const rec of [...sessionIndex.records.values()]) {
      if (rec.runtime !== 'opencode' || rec.state.parent || catalog.view(rec, sessionIndex)?.project !== projectHash) continue;
      if (interaction.isBusy(rec.id)) throw new Error('Close the active OpenCode sessions before deleting this project.');
      await service.api('DELETE', `/api/session/${rec.id}`);
    }
    return true;
  },
});
