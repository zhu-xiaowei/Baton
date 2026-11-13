// DeepSeek Harness (dsh 0.2.2, session log v4): catalog and history from the zstd logs, live rows
// from a watcher on them, interaction over ACP. Registered only when DSH_HOME exists.
import fs from 'node:fs';
import path from 'node:path';
import { defineRuntimeAdapter } from './runtime-adapter.mjs';
import { defineRuntimeWatcher } from './watcher-adapter.mjs';
import { sessionIndex } from './session-index.mjs';
import { storageSessionId } from './session-identity.mjs';
import { lastKnownStatus, reportSessions } from './sync.mjs';
import { publishMessages } from './ws.mjs';
import { batonSessions, localIdleSec } from './presence.mjs';
import dsh, { catalog, DSH_HOME, LOG, SESSIONS, withImages } from './dsh-catalog.mjs';
import { eventRows } from './dsh-extract.mjs';
import { refreshLocks } from './dsh-locks.mjs';
import { dshInteraction, findLog } from './dsh-interaction.mjs';

let config = null;
const busy = new Map(); // log file → { again, done }
const reported = new Map(); // storage id → status and title last reported

const recOf = (file) => sessionIndex.records.get(file);
const rootOf = (rec) => sessionIndex.catalog().roots.find((row) => row.rec === rec || row.children.includes(rec));

function sessionRow(rec, status) {
  const view = sessionIndex.view(rec);
  return { id: rec.id, nativeSessionId: rec.id, runtime: 'dsh', project: view.project, projectName: sessionIndex.projectPath(view.project),
    lastActive: new Date(rec.ms).toISOString(), size: rec.size, preview: view.preview, model: rec.state.model || '', status,
    ...(view.parent ? { parentSessionId: storageSessionId('dsh', view.parent) } : {}) };
}

// The root row of a Session Baton does not drive, and its status: a finished turn still runs while
// a child holds its lock.
function current(file, running) {
  const row = file && rootOf(recOf(file));
  if (!row || dshInteraction.owns(row.rec.id)) return null;
  const all = [row.rec, ...row.children].map((rec) => catalog.status(rec, running));
  return { row, status: all.includes('needs_input') ? 'needs_input' : all.includes('running') ? 'running' : 'completed' };
}

// Sessions Baton does not drive report their own changes; the first report seeds the notifier.
async function report(file) {
  await refreshLocks(SESSIONS);
  const { row, status } = current(file, catalog.running()) || {};
  if (!row) return;
  const sessionId = storageSessionId('dsh', row.rec.id);
  const previous = lastKnownStatus.get(sessionId);
  if (previous === status && reported.get(sessionId) === row.preview) return;
  reported.set(sessionId, row.preview);
  const session = sessionRow(row.rec, status);
  if (previous === 'running' && status !== 'running' && !batonSessions.has(row.rec.id)) session.localIdleSec = await localIdleSec();
  reportSessions(config, [session]);
}

// New frames of a log: the index first, then their rows to the live turn or the subscribers.
async function readLog(file) {
  const id = catalog.match(file)?.id;
  if (!id) return;
  sessionIndex.touch(file);
  const events = catalog.pending?.get(file) || [];
  catalog.pending?.delete(file);
  const rows = await withImages(events.flatMap(({ frame, i, event }) => eventRows(event, frame, i, { sid: id, home: DSH_HOME })));
  if (rows.length && !dshInteraction.deliver(id, rows)) publishMessages(storageSessionId('dsh', id), rows);
  await report(file);
}

// One read per log at a time; a change seen meanwhile reads again.
function queue(file) {
  let job = busy.get(file);
  if (job) { job.again = true; return job.done; }
  busy.set(file, job = { again: false });
  job.done = (async () => {
    do {
      job.again = false;
      try { await readLog(file); } catch (error) { console.error(`[dsh] ${path.basename(path.dirname(file)).slice(0, 8)}: ${error.message}`); }
    } while (job.again);
    busy.delete(file);
  })();
  return job.done;
}

dshInteraction.flush = (sid) => queue(findLog(sid));
dshInteraction.onIdle = (sid) => { const file = findLog(sid); if (file) void report(file); };

const watcher = defineRuntimeWatcher({
  runtime: 'dsh',
  start(next) {
    config = next;
    const watch = () => fs.watch(SESSIONS, { recursive: true }, (_event, name) => {
      if (String(name).endsWith(LOG)) void queue(path.join(SESSIONS, name));
    });
    let handle;
    if (fs.existsSync(SESSIONS)) handle = watch();
    else handle = fs.watch(DSH_HOME, (_event, name) => { if (name === 'sessions' && fs.existsSync(SESSIONS)) { handle.close(); handle = watch(); } });
    void sessionIndex.readyPromise.then(() => {
      catalog.pending = new Map();
      for (const row of sessionIndex.catalog().roots) if (row.rec.runtime === 'dsh') void report(row.rec.file);
    });
    return { stop: () => handle.close() };
  },
});

const dshRecords = () => [...sessionIndex.records.values()].filter((rec) => rec.runtime === 'dsh' && rec.state);

// dsh has no delete: Baton removes the Session folders (subagents too) and DSH's list cache entries.
async function deleteHistory(ids) {
  const all = dshRecords();
  for (let grown = true; grown;) grown = all.some((rec) => !ids.has(rec.id) && ids.has(rec.state.parent) && ids.add(rec.id));
  const recs = all.filter((rec) => ids.has(rec.id));
  for (const rec of recs) if (dshInteraction.owns(rec.id) || await dshInteraction.heldElsewhere(rec.id, rec.file)) throw new Error('Close the active DSH session before deleting its history.');
  for (const rec of recs) {
    fs.rmSync(path.dirname(rec.file), { recursive: true, force: true });
    fs.rmSync(path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions', `${rec.id}.json`), { force: true });
    dshInteraction.forgetGrants(rec.id);
  }
  return true;
}

export default defineRuntimeAdapter({
  runtime: 'dsh',
  displayName: 'DeepSeek Harness',
  module: new URL('./dsh-catalog.mjs', import.meta.url).href,
  ...dsh,
  watcher,
  interaction: dshInteraction,
  features: { create: true, send: true, interrupt: true, deleteHistory: true, statusPolling: true },
  discover: () => ({ sessions: [] }), // the watcher reports DSH rows once the index is warm
  findSessionFile: findLog,
  baselineToEnd() {},
  deleteSessionHistory: (id) => deleteHistory(new Set([id])),
  deleteProjectHistory: (hash) => deleteHistory(new Set(dshRecords().filter((rec) => sessionIndex.view(rec)?.project === hash).map((rec) => rec.id))),
  ownsLiveSession: (id) => dshInteraction.owns(id),
  createStatusContext: catalog.running,
  // A process that died without writing its turn's end leaves the row active until checked here.
  inspectActiveSession(active, running) {
    const { row, status } = current(findLog(active.nativeSessionId), running) || {};
    return row && status !== active.status ? { session: sessionRow(row.rec, status) } : null;
  },
  async updateSessionStatus(next, nativeSessionId, file, _project, status, detail, context) {
    sessionIndex.touch(file);
    const rec = recOf(file);
    if (rec?.state && sessionIndex.view(rec)) context.report(next, [{ ...sessionRow(rec, status), agentDetail: status === 'needs_input' ? detail || '' : '' }]);
  },
});
