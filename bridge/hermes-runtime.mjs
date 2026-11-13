// Hermes on the main thread: interaction through the user's gateway, the state.db watcher, the adapter.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defineRuntimeAdapter } from './runtime-adapter.mjs';
import { defineInteractionAdapter } from './interaction-adapter.mjs';
import { defineRuntimeWatcher } from './watcher-adapter.mjs';
import { StreamFramer } from './stream-framer.mjs';
import { SessionGrants } from './session-grants.mjs';
import { BRIDGE_HOME } from './config.mjs';
import { liveMessageRoute } from './live-message-registry.mjs';
import { trackAgentSession } from './agent-counts.mjs';
import { batonSessions, localIdleSec } from './presence.mjs';
import light, { catalog, HERMES_HOME, HermesHistoryReader, select, STATE_DB, withImages } from './hermes-catalog.mjs';
import { mapTool } from './hermes-convert.mjs';
import { HermesGateway, hermesCli } from './hermes-gateway.mjs';
import { sessionIndex } from './session-index.mjs';
import { storageSessionId } from './session-identity.mjs';
import { lastKnownStatus, reportSessions } from './sync.mjs';
import { pendingInteractionDetail, publishMessages } from './ws.mjs';

// A state.db older than 0.23 (no display projection) is not read: the runtime does not load.
const REQUIRED = ['display_kind', 'display_order', 'active', 'compacted', 'message_uid'];
if (select('messages', REQUIRED).split(', ').length < REQUIRED.length) throw new Error('Hermes state.db is older than 0.23');

const IDLE_MS = 120_000;
const storageId = (id) => storageSessionId('hermes', id);
const grants = new SessionGrants(path.join(BRIDGE_HOME, 'hermes-grants.json'));
const turns = new Map();     // admission id → Baton turn
const prompts = new Map();   // prompt id → { id, kind, generation, multi?, description? }
const observers = new Map(); // Session id → permission callbacks of an App page (turns Baton did not start)
const generations = new Map();
const resumed = new Set();
const readers = new Map();   // Session id → history reader, for rows a change or a turn wrote
let idleTimer = null;
let config = null;
const gateway = new HermesGateway(onEvent);

const activeTurn = (id) => [...turns.values()].some((turn) => turn.id === id);
// Browsing connects only to a gateway that already runs.
const gatewayUp = () => gateway.open || fs.existsSync(path.join(HERMES_HOME, 'gateway.sock'));

function scheduleIdle() {
  clearTimeout(idleTimer);
  // A waiting prompt keeps the connection, so its answer from another client still dismisses it here.
  idleTimer = setTimeout(() => (turns.size || prompts.size ? scheduleIdle() : gateway.close()), IDLE_MS);
  idleTimer.unref?.();
}

async function attach(id, start) {
  await gateway.connect({ start });
  scheduleIdle();
  if (resumed.has(id)) return null;
  const snapshot = await gateway.rpc('session.resume', { session_id: id });
  resumed.add(id);
  if (snapshot.execution_generation != null) generations.set(id, snapshot.execution_generation);
  return snapshot;
}

// The Baton rows of these stored message ids, in history order (same uuids and order keys).
async function storedRows(id, rowIds) {
  const reader = readers.get(id) || new HermesHistoryReader(id);
  readers.delete(id);
  readers.set(id, reader);
  if (readers.size > 16) readers.delete(readers.keys().next().value);
  reader.update();
  const at = rowIds.map((rowId) => reader.index.ids.indexOf(rowId)).filter((i) => i >= 0);
  return at.length ? withImages(await reader.rows(Math.min(...at), Math.max(...at) + 1)) : [];
}

function sessionRow(id, status, state = sessionIndex.records.get(`rows:hermes:${id}`)?.state) {
  const view = state && catalog.view({ id, state }, sessionIndex);
  if (!view) return null;
  return { id, nativeSessionId: id, runtime: 'hermes', project: view.project, projectName: sessionIndex.projectName(view.project),
    preview: view.preview, status, lastActive: new Date(state.ms).toISOString(), size: state.size, model: state.model,
    ...(view.parent ? { parentSessionId: storageId(view.parent), threadKind: 'subagent' } : {}) };
}

// Through the agent counts, so a parent's Done waits for its running subagents.
function report(id, status, state, idle) {
  const session = config && sessionRow(id, status, state);
  if (session) reportSessions(config, [{ ...session, ...(idle !== undefined ? { localIdleSec: idle } : {}) }], { agentCountUpdates: trackAgentSession(session) });
}

function control(e, request) {
  const sink = turns.get(e.admission_id)?.callbacks || observers.get(e.session_id);
  sink?.onControlRequest({ request_id: e.payload.prompt_id, request });
}

function onApproval(e) {
  const p = e.payload;
  const offered = (p.choices || []).includes('session');
  prompts.set(p.prompt_id, { id: e.session_id, kind: 'approval', generation: p.execution_generation, description: p.description });
  // "Yes, for this session" is kept by the gateway until it restarts; the Bridge answers it after that.
  if (offered && grants.get(storageId(e.session_id)).includes(p.description)) {
    return void reply(p.prompt_id, { decision: 'allow', scope: 'session' }).catch(() => {});
  }
  control(e, { tool_name: 'Bash', input: { command: p.command || p.description || '', description: p.description || '' },
    ...(offered ? { permission_suggestions: [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: p.description }] }] } : {}) });
}

function onEvent(e) {
  if (e.type === 'gateway.closed') {
    resumed.clear();
    prompts.clear();
    for (const [admission, turn] of turns) {
      turns.delete(admission);
      turn.callbacks.onError?.(turn.turnId, { code: -1, detail: 'Hermes gateway disconnected' });
    }
    return;
  }
  const p = e.payload || {};
  if (e.session_id && e.execution_generation != null) generations.set(e.session_id, e.execution_generation);
  if (e.type === 'approval.request') return onApproval(e);
  if (e.type === 'clarify.request') {
    prompts.set(p.prompt_id, { id: e.session_id, kind: 'clarify', generation: p.execution_generation, multi: !!p.multi_select });
    return control(e, { tool_name: 'AskUserQuestion', requires_user_interaction: true,
      input: { questions: [{ question: p.question || '', multiSelect: !!p.multi_select, options: (p.choices || []).map((label) => ({ label })) }] } });
  }
  if (/^(approval|clarify)\.(settled|cancelled)$|^request\.cancel$/.test(e.type) && prompts.delete(p.prompt_id || p.id)) {
    return (turns.get(e.admission_id)?.callbacks || observers.get(e.session_id))?.onControlResolved(p.prompt_id || p.id);
  }
  const turn = turns.get(e.admission_id);
  if (turn) onTurnEvent(turn, e.type, p);
}

function openBlock(turn, kind, name = null) {
  if (turn.block?.kind === kind && !name) return turn.block.id;
  closeBlock(turn);
  turn.block = { id: turn.nextBlock++, kind };
  turn.framer.start(turn.block.id, kind, name);
  return turn.block.id;
}

function closeBlock(turn) {
  if (turn.block) turn.framer.stop(turn.block.id);
  turn.block = null;
}

// Rows the running Baton turn or another client stored: into that turn's stream, else to the page.
async function publishRows(id, rowIds, turn = [...turns.values()].find((t) => t.id === id && t.started)) {
  const rows = (await storedRows(id, rowIds)).filter((row) => !turn?.sent.has(row.uuid) && !liveMessageRoute('hermes', row.uuid)?.pushed);
  if (!turn) return publishMessages(storageId(id), rows);
  for (const row of rows) {
    turn.sent.add(row.uuid);
    turn.callbacks.onMessage?.(turn.turnId, row, { normalized: true, runtime: 'hermes', liveKey: row.uuid });
  }
}

function onTurnEvent(turn, type, p) {
  const cb = turn.callbacks;
  if (type === 'message.start') {
    turn.started = true;
    cb.onAccepted?.(turn.turnId);
    const prompt = { uuid: turn.turnId, nativeId: `live:user:${turn.turnId}`, type: 'user', content: [{ type: 'text', text: turn.text }], timestamp: new Date().toISOString() };
    cb.onMessage?.(turn.turnId, prompt, { normalized: true, runtime: 'hermes', liveKey: prompt.uuid });
  } else if (type === 'reasoning.delta' && p.text) turn.framer.delta(openBlock(turn, 'thinking'), p.text);
  else if (type === 'message.delta' && p.text) turn.framer.delta(openBlock(turn, 'text'), p.text);
  else if (type === 'tool.start') {
    const tool = mapTool(p.name, p.args);
    const blockId = openBlock(turn, 'tool_use', tool.name);
    turn.framer.input(blockId, JSON.stringify(tool.input));
    closeBlock(turn);
  } else if (type === 'message.complete') void endTurn(turn, p);
}

async function endTurn(turn, p) {
  turns.delete(turn.admission);
  closeBlock(turn);
  turn.framer.finish();
  const cb = turn.callbacks;
  await publishRows(turn.id, p.persisted_turn?.row_ids || [], turn).catch((error) => console.error(`[hermes] turn rows: ${error.message}`));
  cb.onResult?.(turn.turnId, { is_error: p.status === 'error' || p.outcome === 'failed', subtype: p.outcome, status: p.status });
  // A new Session's live turn does not report its own end.
  if (turn.fresh && !activeTurn(turn.id)) report(turn.id, 'completed');
  scheduleIdle();
}

async function submit(id, turnId, text, callbacks, fresh = false) {
  // Images arrive as local paths (resolveBridgeImages); Hermes takes them as staged attachments.
  const attachments = [];
  for (const [ref, file] of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
    if (!fs.existsSync(file)) continue;
    const staged = await gateway.rpc('image.attach_bytes', { session_id: id, content_base64: fs.readFileSync(file).toString('base64'), filename: path.basename(file) });
    attachments.push({ path: staged.path, mime: staged.mime });
    text = text.replace(ref, '').trim();
  }
  const turn = { id, turnId, text, callbacks, fresh, block: null, nextBlock: 0, sent: new Set() };
  turn.framer = new StreamFramer((f) => {
    if (f.t === 'start') callbacks.onBlockStart?.(turnId, f.blockId, f.kind, f.name);
    else if (f.t === 'delta') callbacks.onDelta?.(turnId, f.chunk, f.blockId);
    else if (f.t === 'input') callbacks.onInputDelta?.(turnId, f.chunk, f.blockId);
    else callbacks.onBlockStop?.(turnId, f.blockId);
  });
  // A prompt sent while a turn runs waits in Hermes' own queue and starts as the next turn.
  const result = await gateway.rpc('prompt.submit', { session_id: id, submission_id: turnId, text, ...(attachments.length ? { attachments } : {}) });
  turn.admission = result.admission_id;
  turns.set(turn.admission, turn);
}

async function reply(requestId, { decision, answers, answerText, scope }) {
  const prompt = prompts.get(requestId);
  if (!prompt) return false;
  const base = { session_id: prompt.id, prompt_id: requestId, execution_generation: prompt.generation };
  if (prompt.kind === 'clarify') {
    const picked = Object.values(answers || {})[0] || (answerText ? [answerText] : []);
    const answer = decision === 'deny' ? '' : prompt.multi ? JSON.stringify(picked) : picked[0] || '';
    return gateway.rpc('clarify.respond', { ...base, answer });
  }
  const choice = decision !== 'allow' ? 'deny' : scope === 'session' ? 'session' : 'once';
  if (choice === 'session') grants.add(storageId(prompt.id), [prompt.description]);
  return gateway.rpc('approval.respond', { ...base, choice });
}

const interaction = defineInteractionAdapter({
  runtime: 'hermes',

  async create({ cwd, text, streamId, onCreated }) {
    await gateway.connect({ start: true });
    const created = await gateway.rpc('session.create', { source: 'tui', cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir(),
      client: { name: 'baton' }, request_id: randomUUID() });
    const id = created.session_id;
    resumed.add(id);
    await sessionIndex.touch(STATE_DB); // the row exists now; list it before the first frame
    const callbacks = await onCreated({ nativeSessionId: id, sessionId: storageId(id) });
    await submit(id, streamId, text, callbacks, true);
  },

  async sendExisting({ nativeSessionId: id, streamId, text, callbacks }) {
    if (sessionIndex.view(sessionIndex.records.get(`rows:hermes:${id}`) || {})?.readOnly) throw new Error('This Hermes Session is read-only.');
    await attach(id, true);
    await submit(id, streamId, text, callbacks);
  },

  async interrupt(id) {
    if (gateway.open) await gateway.rpc('session.interrupt', { session_id: id, execution_generation: generations.get(id) });
  },

  replyControl(_id, requestId, response) {
    if (!prompts.has(requestId)) return false;
    reply(requestId, response).catch((error) => console.error(`[hermes] reply: ${error.message}`));
    return true;
  },

  // An App page opened the Session: re-show what waits there, and see its prompts from other clients.
  async observePermissions({ nativeSessionId: id, callbacks }) {
    observers.set(id, callbacks);
    if (!gatewayUp()) return;
    const snapshot = await attach(id, false).catch(() => null);
    for (const p of snapshot?.prompts || []) onEvent({ type: `${p.kind}.request`, session_id: id, payload: p });
  },

  async listCommands() {
    if (!gatewayUp()) return { commands: [], skills: [] };
    await gateway.connect();
    scheduleIdle();
    const catalog = await gateway.rpc('commands.catalog', {});
    const describe = new Map(catalog.pairs || []);
    // Skills run by name as a prompt; the gateway expands them.
    const commands = Object.keys(catalog.skills || {}).map((name) => ({ name: name.slice(1), description: describe.get(name) || '', behavior: 'compose' }));
    return { commands, skills: [] };
  },

  owns: activeTurn,
  isBusy: activeTurn,
  shutdown: () => gateway.close(),
});

// state.db changed: report status changes and push rows that other clients wrote to open pages.
async function onRows(rows, added) {
  const running = catalog.running();
  const states = new Map(rows.map((state) => [state.id, state]));
  // A turn's end can be only its lease going away; Sessions shown running are checked on every change.
  for (const [sessionId, status] of lastKnownStatus) {
    const id = status === 'running' && sessionId.startsWith('hermes:') && sessionId.slice(7);
    const state = id && !states.has(id) && sessionIndex.records.get(`rows:hermes:${id}`)?.state;
    if (state) states.set(id, state);
  }
  for (const [id, state] of states) {
    if (activeTurn(id) || pendingInteractionDetail(storageId(id)) !== null) continue; // reported by the turn
    const status = catalog.status({ id, state }, running);
    const previous = lastKnownStatus.get(storageId(id));
    // Messaging and cron turns alert like any turn; only local roots ask whether the user is at the computer.
    const away = previous === 'running' && status !== 'running' && !state.parent && !batonSessions.has(id)
      && !catalog.view({ id, state }, sessionIndex)?.readOnly;
    if (previous !== status) report(id, status, state, away ? await localIdleSec() : undefined);
  }
  for (const [id, rowIds] of added) await publishRows(id, rowIds);
}

const watcher = defineRuntimeWatcher({
  runtime: 'hermes',
  start(bridgeConfig) {
    config = bridgeConfig;
    catalog.onRows = (rows, added) => void onRows(rows, added).catch((error) => console.error(`[hermes] watcher: ${error.message}`));
    let again = null;
    const watch = fs.watch(HERMES_HOME, (_event, name) => {
      if (name !== 'state.db' && name !== 'state.db-wal') return;
      sessionIndex.touch(STATE_DB);
      // A WAL write is seen just before its commit becomes visible: read once more after it.
      again ||= setTimeout(() => { again = null; sessionIndex.touch(STATE_DB); }, 50);
    });
    return { close: () => watch.close() };
  },
});

async function cli(args) {
  const { error, stderr } = await hermesCli(args);
  if (error) throw new Error(String(stderr).trim().split('\n').at(-1) || error.message);
  return true;
}

export default defineRuntimeAdapter({
  ...light,
  displayName: 'Hermes',
  features: { create: true, send: true, interrupt: true, deleteHistory: true },
  interaction,
  watcher,

  // Startup statuses, read straight from state.db (the index fills in later).
  discover() {
    const running = catalog.running();
    const sessions = (catalog.refresh(null).upserts || []).map((state) => sessionRow(state.id, catalog.status({ id: state.id, state }, running), state)).filter(Boolean);
    return { sessions };
  },
  findSessionFile: (id) => (sessionIndex.records.has(`rows:hermes:${id}`) ? `rows:hermes:${id}` : null),
  baselineToEnd() {},
  async updateSessionStatus(bridgeConfig, id, _file, _project, status, detail, context) {
    const session = sessionRow(id, status);
    if (!session) return;
    session.agentDetail = status === 'needs_input' ? detail || '' : '';
    context.report(bridgeConfig, [session], { agentCountUpdates: trackAgentSession(session) });
  },
  rename: async (id, name) => (await cli(['sessions', 'rename', '--', id, name]), name),
  async deleteSessionHistory(id) {
    await cli(['sessions', 'delete', '--yes', id]);
    grants.forget(storageId(id));
    return true;
  },
  async deleteProjectHistory(projectHash) {
    const rows = sessionIndex.catalog().byProject.get(projectHash) || [];
    for (const row of rows.filter((r) => r.rec.runtime === 'hermes')) await this.deleteSessionHistory(row.rec.id);
    return true;
  },
});
