// Pi runtime: registered at Bridge start (runtime-registry.mjs) when `pi` ≥ 1.0 is installed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import piDescriptor, { PI_AGENT_DIR, PI_SESSIONS, PI_STATUS_DIR, piCatalog, piRows, withImages } from './pi-catalog.mjs';
import { createPiInteraction, piGrants } from './pi-interaction.mjs';
import { defineRuntimeAdapter } from './runtime-adapter.mjs';
import { defineRuntimeWatcher } from './watcher-adapter.mjs';
import { findRuntimeBin, pickNode } from './runtime-bin.mjs';
import { sessionIndex } from './session-index.mjs';
import { storageSessionId } from './session-identity.mjs';
import { liveMessageRoute } from './live-message-registry.mjs';
import { batonSessions, localIdleSec } from './presence.mjs';

export const PI_EXTENSION = path.join(PI_AGENT_DIR, 'extensions', 'baton-bridge-status.js');
let launch = null;

const findRecord = (id) => {
  for (const rec of sessionIndex.records.values()) if (rec.runtime === 'pi' && rec.id === id) return rec;
  return null;
};

function sessionRow(rec, status, detail = '') {
  const view = sessionIndex.view(rec) || {};
  return { id: rec.id, nativeSessionId: rec.id, runtime: 'pi', project: view.project || '',
    projectName: view.project ? sessionIndex.projectPath(view.project) : '', lastActive: new Date(rec.ms).toISOString(),
    size: rec.size, preview: view.preview || '', model: rec.state?.model || '', status, agentDetail: status === 'needs_input' ? detail : '' };
}

// Like Orca: the status extension is (re)written whenever its content differs, atomically.
function installStatusExtension() {
  const source = fs.readFileSync(fileURLToPath(new URL('./pi-status-ext.mjs', import.meta.url)), 'utf8');
  const content = `// managed by Baton Bridge v1\n${source.replace('__STATUS_DIR__', JSON.stringify(PI_STATUS_DIR))}`;
  try { if (fs.readFileSync(PI_EXTENSION, 'utf8') === content) return; } catch {}
  fs.mkdirSync(path.dirname(PI_EXTENSION), { recursive: true });
  fs.writeFileSync(`${PI_EXTENSION}.tmp`, content);
  fs.renameSync(`${PI_EXTENSION}.tmp`, PI_EXTENSION);
}

// Changes are read one pass at a time per key; a change seen meanwhile gets one more pass.
function coalesce(busy, key, run) {
  if (busy.has(key)) return void busy.set(key, true);
  busy.set(key, false);
  void (async () => {
    do {
      busy.set(key, false);
      try { await run(); } catch (error) { console.error(`[pi] ${error.message}`); }
    } while (busy.get(key));
    busy.delete(key);
  })();
}

const piWatcher = defineRuntimeWatcher({
  runtime: 'pi',
  async start(config) {
    const [{ publishMessages }, { lastKnownStatus, reportSessions }] = await Promise.all([import('./ws.mjs'), import('./sync.mjs')]);
    const busy = new Map();
    const edits = new Map();
    // Appended entries go to the Session's subscribers, except rows Baton's own turn already pushed.
    async function read(file) {
      const before = sessionIndex.records.get(file)?.state?.offset;
      sessionIndex.touch(file);
      const rec = sessionIndex.records.get(file);
      // Baton's own process streams its rows itself.
      if (!rec?.state || before === undefined || rec.state.offset <= before || interaction.owns(rec.id)) return;
      const buf = Buffer.alloc(rec.state.offset - before);
      const fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, buf, 0, buf.length, before); } finally { fs.closeSync(fd); }
      const rows = buf.toString('utf8').split('\n').flatMap((line) => { try { return line ? piRows(JSON.parse(line), edits) : []; } catch { return []; } })
        .filter((row) => !liveMessageRoute('pi', row.nativeId)?.pushed);
      publishMessages(storageSessionId('pi', rec.id), await Promise.all(rows.map(withImages)));
    }
    async function statuses() {
      const byId = piCatalog.running();
      if (sessionIndex.running) sessionIndex.running.pi = byId;
      const rows = [];
      for (const row of sessionIndex.catalog().roots) {
        if (row.rec.runtime !== 'pi') continue;
        const old = lastKnownStatus.get(row.sessionId);
        const status = piCatalog.status(row.rec, byId);
        if (status === (old || 'completed')) continue;
        const session = sessionRow(row.rec, status);
        // A terminal turn that ends while the user is at the computer does not alert.
        if (old === 'running' && !batonSessions.has(row.rec.id)) session.localIdleSec = await localIdleSec();
        rows.push(session);
      }
      if (rows.length) reportSessions(config, rows);
    }
    try { installStatusExtension(); } catch (error) { console.error(`[pi] status extension: ${error.message}`); }
    fs.mkdirSync(PI_SESSIONS, { recursive: true });
    fs.mkdirSync(PI_STATUS_DIR, { recursive: true });
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
});

const interaction = createPiInteraction({ launch: () => launch, findSession: findRecord, statusRecords: piCatalog.running });

function remove(rec) {
  if (interaction.isBusy(rec.id) || interaction.heldElsewhere(rec.id)) throw new Error('the Session is in use');
  fs.rmSync(rec.file, { force: true });
  piGrants.forget(rec.id);
}

export const piRuntime = {
  ...piDescriptor,
  ...defineRuntimeAdapter({
    runtime: 'pi',
    displayName: 'Pi',
    features: { create: true, send: true, interrupt: true, deleteHistory: true, statusPolling: true },
    interaction,
    // Statuses come from the status extension (watcher) and Baton's own turns; history is read on demand.
    discover: () => ({ sessions: [] }),
    findSessionFile: (id) => findRecord(id)?.file || null,
    baselineToEnd() {},
    deleteSessionHistory(id) {
      const rec = findRecord(id);
      if (rec) remove(rec);
      return true;
    },
    deleteProjectHistory(hash) {
      const recs = [...sessionIndex.records.values()].filter((rec) => rec.runtime === 'pi' && sessionIndex.view(rec)?.project === hash);
      if (recs.some((rec) => interaction.isBusy(rec.id) || interaction.heldElsewhere(rec.id))) throw new Error('a Session is in use');
      recs.forEach(remove);
      return true;
    },
    createStatusContext: () => ({ byId: piCatalog.running() }),
    inspectActiveSession(active, context) {
      const rec = findRecord(active.nativeSessionId);
      const status = rec && piCatalog.status(rec, context.byId);
      return rec && status !== active.status ? { session: sessionRow(rec, status) } : null;
    },
    // A new Session's first turn can end before its file is found: then the file's status counts.
    async updateSessionStatus(config, id, _file, _project, status, detail, context) {
      const rec = findRecord(id);
      if (rec) context.report(config, [sessionRow(rec, interaction.owns(id) ? status : piCatalog.status(rec, piCatalog.running()), detail)]);
    },
  }),
  // Pi's own rename (SessionManager.appendSessionInfo): a session_info entry on the current leaf.
  rename(id, name) {
    const rec = findRecord(id);
    if (!rec) throw new Error('Session not found on this device.');
    const tail = fs.readFileSync(rec.file, 'utf8').slice(-(1 << 16));
    const parentId = [...tail.matchAll(/^\{"type":"[a-z_]+","id":"([^"]+)"/gm)].at(-1)?.[1] || null;
    fs.appendFileSync(rec.file, `${JSON.stringify({ type: 'session_info', id: crypto.randomBytes(4).toString('hex'), parentId,
      timestamp: new Date().toISOString(), name })}\n`);
  },
  watcher: piWatcher,
  detect() {
    const pi = findRuntimeBin('pi', [], '1.0.0');
    const node = pi && pickNode('22.19.0');
    if (!node) return false;
    // pi is a node script: run its cli.js with a node that is new enough (npm's .cmd shim on Windows).
    launch = /\.cmd$/i.test(pi.bin) ? { bin: pi.bin, pre: [] } : { bin: node.bin, pre: [fs.realpathSync(pi.bin)] };
    return true;
  },
};
