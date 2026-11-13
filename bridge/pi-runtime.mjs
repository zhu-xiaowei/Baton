// Pi runtime (runtime-registry OPTIONAL_RUNTIMES).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import piDescriptor, { PI_AGENT_DIR, PI_SESSIONS, PI_STATUS_DIR, piCatalog, piRows, withImages } from './pi-catalog.mjs';
import { createPiInteraction, piGrants } from './pi-interaction.mjs';
import { defineRuntimeAdapter } from './runtime-adapter.mjs';
import { findRuntimeBin, pickNode } from './runtime-bin.mjs';
import { sessionIndex } from './session-index.mjs';
import { storageSessionId } from './session-identity.mjs';
import { liveMessageRoute } from './live-message-registry.mjs';
import { batonSessions, localIdleSec } from './presence.mjs';

const EXTENSION = path.join(PI_AGENT_DIR, 'extensions', 'baton-bridge-status.js');
const records = () => [...sessionIndex.records.values()].filter((rec) => rec.runtime === 'pi');
const findRecord = (id) => records().find((rec) => rec.id === id) || null;
const running = piCatalog.running;

function sessionRow(rec, status, detail = '') {
  const { project = '', preview = '' } = sessionIndex.view(rec) || {};
  return { id: rec.id, nativeSessionId: rec.id, runtime: 'pi', project, projectName: project && sessionIndex.projectPath(project),
    lastActive: new Date(rec.ms).toISOString(), size: rec.size, preview, model: rec.state?.model || '', status,
    agentDetail: status === 'needs_input' ? detail : '' };
}

// Like Orca: rewritten (atomically) whenever its content differs.
function installStatusExtension() {
  const content = `// managed by Baton Bridge v1\n${fs.readFileSync(new URL('./pi-status-ext.mjs', import.meta.url), 'utf8')
    .replace('__STATUS_DIR__', JSON.stringify(PI_STATUS_DIR))}`;
  try { if (fs.readFileSync(EXTENSION, 'utf8') === content) return; } catch {}
  fs.mkdirSync(path.dirname(EXTENSION), { recursive: true });
  fs.writeFileSync(`${EXTENSION}.tmp`, content);
  fs.renameSync(`${EXTENSION}.tmp`, EXTENSION);
}

// One pass at a time per key; a change seen meanwhile gets one more pass.
function coalesce(busy, key, run) {
  if (busy.has(key)) return void busy.set(key, true);
  void (async () => {
    do {
      busy.set(key, false);
      try { await run(); } catch (error) { console.error(`[pi] ${error.message}`); }
    } while (busy.get(key));
    busy.delete(key);
  })();
}

const interaction = createPiInteraction({ launch, findSession: findRecord, statusRecords: running });
// Pi itself does not refuse to delete or rename a busy or open Session.
const inUse = (id) => interaction.isBusy(id) || interaction.heldElsewhere(id);
const refuseInUse = (recs) => { if (recs.some((rec) => inUse(rec.id))) throw new Error('the Session is in use'); };
function removeAll(recs) {
  refuseInUse(recs);
  for (const rec of recs) { fs.rmSync(rec.file, { force: true }); piGrants.forget(rec.id); }
  return true;
}

const watcher = {
  runtime: 'pi',
  async start(config) {
    const [{ publishMessages }, { lastKnownStatus, reportSessions }] = await Promise.all([import('./ws.mjs'), import('./sync.mjs')]);
    const busy = new Map();
    const edits = new Map();
    // Appended entries go to subscribers; Baton's own process streams its rows itself.
    async function read(file) {
      const before = sessionIndex.records.get(file)?.state?.offset;
      sessionIndex.touch(file);
      const rec = sessionIndex.records.get(file);
      if (!rec?.state || before === undefined || rec.state.offset <= before || interaction.owns(rec.id)) return;
      const buf = Buffer.alloc(rec.state.offset - before);
      const fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, buf, 0, buf.length, before); } finally { fs.closeSync(fd); }
      const rows = buf.toString('utf8').split('\n').flatMap((line) => { try { return line ? piRows(JSON.parse(line), edits) : []; } catch { return []; } })
        .filter((row) => !liveMessageRoute('pi', row.nativeId)?.pushed);
      publishMessages(storageSessionId('pi', rec.id), await Promise.all(rows.map(withImages)));
    }
    async function statuses() {
      const byId = running();
      if (sessionIndex.running) sessionIndex.running.pi = byId;
      const rows = [];
      for (const { rec, sessionId } of sessionIndex.catalog().roots) {
        const old = lastKnownStatus.get(sessionId);
        const status = rec.runtime === 'pi' && piCatalog.status(rec, byId);
        if (!status || status === (old || 'completed')) continue;
        const session = sessionRow(rec, status);
        // A terminal turn that ends while the user is at the computer does not alert.
        if (old === 'running' && !batonSessions.has(rec.id)) session.localIdleSec = await localIdleSec();
        rows.push(session);
      }
      if (rows.length) reportSessions(config, rows);
    }
    try { installStatusExtension(); } catch (error) { console.error(`[pi] status extension: ${error.message}`); }
    for (const dir of [PI_SESSIONS, PI_STATUS_DIR]) fs.mkdirSync(dir, { recursive: true });
    await sessionIndex.readyPromise;
    const watchers = [
      fs.watch(PI_SESSIONS, { recursive: true }, (_e, name) => {
        if (name?.endsWith('.jsonl')) coalesce(busy, name, () => read(path.join(PI_SESSIONS, name)));
      }),
      fs.watch(PI_STATUS_DIR, () => coalesce(busy, '', statuses)),
    ];
    coalesce(busy, '', statuses);
    return { close: () => watchers.forEach((w) => w.close()) };
  },
};

export const piRuntime = {
  ...piDescriptor,
  ...defineRuntimeAdapter({
    runtime: 'pi',
    displayName: 'Pi',
    features: { create: true, send: true, interrupt: true, deleteHistory: true, statusPolling: true },
    interaction,
    // Statuses come from the status extension and Baton's turns.
    discover: () => ({ sessions: [] }),
    findSessionFile: (id) => findRecord(id)?.file || null,
    baselineToEnd() {},
    deleteSessionHistory: (id) => removeAll(records().filter((rec) => rec.id === id)),
    deleteProjectHistory: (hash) => removeAll(records().filter((rec) => sessionIndex.view(rec)?.project === hash)),
    createStatusContext: () => ({ byId: running() }),
    inspectActiveSession(active, { byId }) {
      const rec = findRecord(active.nativeSessionId);
      const status = rec && piCatalog.status(rec, byId);
      return rec && status !== active.status ? { session: sessionRow(rec, status) } : null;
    },
    // A new Session's first turn can end before its file is found: then the file's status counts.
    async updateSessionStatus(config, id, _file, _project, status, detail, context) {
      const rec = findRecord(id);
      if (rec) context.report(config, [sessionRow(rec, interaction.owns(id) ? status : piCatalog.status(rec, running()), detail)]);
    },
  }),
  // Pi's own rename (appendSessionInfo): a session_info entry on the last entry.
  rename(id, name) {
    const rec = findRecord(id);
    if (!rec) throw new Error('Session not found on this device.');
    refuseInUse([rec]);
    sessionIndex.touch(rec.file);
    fs.appendFileSync(rec.file, `${JSON.stringify({ type: 'session_info', id: crypto.randomBytes(4).toString('hex'), parentId: rec.state?.leaf || null,
      timestamp: new Date().toISOString(), name })}\n`);
  },
  watcher,
};
export default piRuntime;

let found;
function launch() {
  if (found) return found;
  const pi = findRuntimeBin('pi', [], '1.0.0');
  const cli = pi && fs.realpathSync(pi.bin);
  const head = Buffer.alloc(128);
  if (cli) { const fd = fs.openSync(cli, 'r'); fs.readSync(fd, head, 0, 128, 0); fs.closeSync(fd); }
  // Found on first use. A JS entry runs on a new enough node; a wrapper (sh/.cmd shim) runs as is.
  const node = (/\.[cm]?js$/.test(cli) || /^#!.*\bnode\b/.test(head.toString('latin1'))) && pickNode('22.19.0');
  if (!pi || node === null) throw new Error('Pi ≥ 1.0 with Node.js ≥ 22.19 was not found on this computer.');
  return (found = node ? { bin: node.bin, pre: [cli] } : { bin: pi.bin, pre: [] });
}
