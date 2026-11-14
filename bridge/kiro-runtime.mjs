// Kiro interaction, watcher and adapter. A Baton turn runs `kiro-cli acp --agent-engine=v3` (v3 must be
// named, or it may fall back to v2), which exits once the Session is Done (session/close, then EOF).
// Text streams from ACP; every row comes from messages.jsonl, so a live turn and its history match.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import kiro, { CLIENT, HOME, LEASES, ROOT, KiroReader, mapTool, parse, readLease, sessionFile } from './kiro.mjs';
import { RpcStdio } from './rpc-stdio.mjs';
import { finishProcess, sessionProcess } from './turn-process.mjs';
import { StreamFramer } from './stream-framer.mjs';
import { findRuntimeBin } from './runtime-bin.mjs';
import { BRIDGE_VERSION } from './version.mjs';
import { defineRuntimeAdapter } from './runtime-adapter.mjs';
import { defineInteractionAdapter } from './interaction-adapter.mjs';
import { defineRuntimeWatcher } from './watcher-adapter.mjs';
import { sessionIndex } from './session-index.mjs';
import { storageSessionId } from './session-identity.mjs';
import { lastKnownStatus, reportSessions } from './sync.mjs';
import { _grants as grants, publishMessages } from './ws.mjs';
import { batonSessions, localIdleSec } from './presence.mjs';

const conns = new Map(); // native id → { key, cwd, id, rpc, ready, loaded, turn }
const drains = new Map(); // jsonl → { reader, from, busy, again }
const commands = new Map(); // cwd → ACP available commands
let bin = null;
let config = null;
let spawned = 0;
const watches = {};

const sid = (id) => storageSessionId('kiro', id);
const recOf = (id) => sessionIndex.records.get(sessionFile(id));
// Found at the first use and kept, a miss too ('').
const kiroBin = () => (bin ??= findRuntimeBin('kiro-cli', [], '3.0.0')?.bin || '') || Promise.reject(new Error('kiro-cli 3.x was not found on this device.'));

// A closed session holds no lease, so a new turn starts at once while the old process is still exiting.
function connect(cwd) {
  const c = { key: `kiro:${++spawned}`, cwd };
  c.ready = (async () => {
    const child = await sessionProcess(c.key, await kiroBin(), ['acp', '--agent-engine=v3'], { cwd });
    c.rpc = new RpcStdio(child, { onNotify: (method, params) => notified(c, method, params), onRequest: (method, params) => requested(c, method, params) });
    child.once('exit', () => {
      if (conns.get(c.id) === c) conns.delete(c.id);
      if (c.turn) endTurn(c, c.turn, 'error', 'Kiro exited');
    });
    await c.rpc.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: CLIENT, version: BRIDGE_VERSION } }, { timeoutMs: 60_000 });
  })();
  return c;
}

// session/close releases the lease at once; the process leaves a few seconds after EOF.
function close(c) {
  if (conns.get(c.id) === c) conns.delete(c.id);
  return finishProcess(c.key, c.id && c.rpc && (() => c.rpc.request('session/close', { sessionId: c.id }, { timeoutMs: 5000 })));
}

function newTurn(c, sessionId, streamId, callbacks) {
  const turn = { sessionId, streamId, callbacks, block: null, tools: new Map(), asks: new Map(), stored: new Set() };
  turn.started = new Promise((resolve) => { turn.start = resolve; });
  turn.ended = new Promise((resolve) => { turn.end = resolve; });
  const on = { start: callbacks.onBlockStart, delta: callbacks.onDelta, input: callbacks.onInputDelta, stop: callbacks.onBlockStop };
  turn.framer = new StreamFramer((f) => on[f.t]?.(sessionId, ...(f.t === 'start' ? [f.blockId, f.kind, f.name] : f.chunk === undefined ? [f.blockId] : [f.chunk, f.blockId])));
  return (c.turn = turn);
}

const stopBlock = (turn) => {
  if (turn.block) turn.framer.stop(turn.block);
  turn.block = null;
};

// Attached images go to Kiro as ACP image blocks.
function prompt(text) {
  const images = [];
  const rest = text.replace(/!\[[^\]]*\]\(([^)]+\.(png|jpe?g|gif|webp))\)/gi, (match, file, ext) => {
    try { images.push({ type: 'image', mimeType: `image/${ext.toLowerCase().replace('jpg', 'jpeg')}`, data: fs.readFileSync(file).toString('base64') }); return ''; } catch { return match; }
  });
  return [{ type: 'text', text: rest.trim() || text }, ...images];
}

function run(c, turn, text) {
  // The Baton turn id is stored on the user row (userMessageTag), its nativeId in history.
  c.rpc.request('session/prompt', { sessionId: c.id, prompt: prompt(text), _meta: { kiro: { userMessageTag: turn.streamId } } })
    .then((result) => endTurn(c, turn, result?.stopReason), (error) => endTurn(c, turn, 'error', error.message));
  turn.callbacks.onAccepted?.();
}

async function endTurn(c, turn, stop, error) {
  if (c.turn !== turn || turn.ending) return;
  turn.ending = true;
  stopBlock(turn);
  turn.framer.finish();
  const file = sessionFile(c.id);
  if (file) await drain(file);
  if (error) console.error(`[kiro] turn failed: ${error}`);
  c.turn = null;
  turn.callbacks.onResult?.(turn.sessionId, { is_error: stop !== 'end_turn', subtype: stop === 'cancelled' ? 'interrupted' : stop === 'end_turn' ? undefined : stop || 'error',
    interruptAuthority: true });
  const closing = close(c);
  turn.end();
  await closing;
  void reportStatus(recOf(c.id));
}

function notified(c, method, p) {
  if (method !== 'session/update') return;
  const u = p.update;
  const turn = c.turn;
  if (u.sessionUpdate === 'available_commands_update') commands.set(c.cwd, u.availableCommands);
  if (!turn) return;
  if (u.sessionUpdate === 'tool_call') {
    turn.tools.set(u.toolCallId, u.rawInput);
    stopBlock(turn);
  } else if (p.sessionId === c.id && u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text' && u._meta?.kiro?.replayId
    && !turn.stored.has(u._meta.kiro.replayId)) {
    // replayId is the stored Say row's id, so its authority row replaces this block.
    if (turn.block !== u._meta.kiro.replayId) {
      stopBlock(turn);
      turn.framer.start(turn.block = u._meta.kiro.replayId, 'text');
    }
    turn.framer.delta(turn.block, u.content.text);
  } else if (u._meta?.kiro?.kind === 'turn_start') turn.start();
  const file = sessionFile(c.id);
  if (file) void drain(file);
}

async function requested(c, method, p) {
  if (method !== 'session/request_permission') throw Object.assign(new Error(`${method} not supported`), { code: -32601 });
  const k = p._meta?.kiro || {};
  const consent = k.consent || {};
  const pick = (kind) => ({ outcome: { outcome: 'selected', optionId: (p.options.find((o) => o.kind === kind)
    || p.options.find((o) => o.kind.startsWith(kind.split('_')[0])))?.optionId } });
  const resource = consent.triggeringResource || consent.resource;
  const grant = consent.capability && resource ? `${consent.capability}(${resource})` : '';
  // A Skill the user asked for loads without a prompt; "for this session" grants are answered again.
  if (consent.capability === 'skill') return pick('allow_once');
  if (grant && grants.get(sid(c.id)).includes(grant)) return pick('allow_always');
  const turn = c.turn;
  if (!turn) return { outcome: { outcome: 'cancelled' } };
  const id = p.toolCall?.toolCallId;
  const [name, input] = mapTool(k.toolId === 'run_command' ? 'execute_bash' : k.toolId, turn.tools.get(id) || { command: k.command });
  return new Promise((resolve) => {
    turn.asks.set(id, { resolve, pick, grant });
    turn.callbacks.onControlRequest({ request_id: id, request: { tool_name: name, input,
      permission_suggestions: grant && p.options.some((o) => o.kind === 'allow_always')
        ? [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: consent.capability, ruleContent: resource }] }] : [] } });
  });
}

// New rows of a jsonl: into the Baton turn that owns the session, else to the session's subscribers.
// A session Baton just created is drained from its first line, however far the index has read it.
function drain(file, from = conns.get(parse(file).id)?.created ? 0 : sessionIndex.records.get(file)?.state?.lines ?? 0) {
  let d = drains.get(file);
  if (!d) {
    drains.set(file, d = { reader: new KiroReader(file), from });
    if (drains.size > 64) drains.delete(drains.keys().next().value);
  }
  if (d.busy) { d.again = true; return d.busy; }
  d.busy = (async () => {
    do {
      d.again = false;
      try { d.reader.update(); } catch { return; }
      const end = d.reader.index.count - (d.reader.index.provisional ? 1 : 0);
      const rows = await d.reader.rows(d.from, end);
      d.from = Math.max(d.from, end);
      const { id } = parse(file);
      const turn = conns.get(id)?.turn;
      for (const row of turn ? rows : []) {
        // A stored Say row is complete: it ends its streamed block, and later chunks of it are dropped.
        turn.stored.add(row.uuid);
        if (row.uuid === turn.block) stopBlock(turn);
        // The App draws a live tool card from a stream block; the stored row then fills it in.
        for (const block of row.content.filter?.((b) => b.type === 'tool_use') || []) {
          stopBlock(turn);
          turn.framer.start(block.id, 'tool_use', block.name);
          turn.framer.input(block.id, JSON.stringify(block.input));
          turn.framer.stop(block.id);
        }
        turn.callbacks.onMessage(turn.sessionId, row, { normalized: true });
      }
      if (!turn) publishMessages(sid(id), rows);
    } while (d.again);
  })().catch((error) => console.error(`[kiro] ${error.message}`)).finally(() => { d.busy = null; });
  return d.busy;
}

function sessionRow(rec, status) {
  const view = sessionIndex.view(rec);
  return view && !view.parent && { id: rec.id, nativeSessionId: rec.id, runtime: 'kiro', project: view.project, projectName: sessionIndex.projectPath(view.project),
    lastActive: new Date(rec.ms).toISOString(), size: rec.size, preview: view.preview, model: rec.state.model, status,
    agentDetail: status === 'needs_input' ? rec.state.question : '' };
}

// Sessions outside a Baton turn: status from the jsonl and the lease (Baton's own turns report theirs).
async function reportStatus(rec) {
  if (!rec || conns.get(rec.id)?.turn || !config) return;
  const status = kiro.catalog.status(rec, kiro.catalog.running(), Date.now());
  const old = lastKnownStatus.get(sid(rec.id));
  const row = old !== status && sessionRow(rec, status);
  if (!row) return;
  if (old === 'running' && !batonSessions.has(rec.id)) row.localIdleSec = await localIdleSec();
  reportSessions(config, [row]);
}

function changed(full) {
  const name = path.basename(full);
  if (name === 'dashboard-meta.json') {
    for (const rec of sessionIndex.records.values()) if (rec.runtime === 'kiro') rec.view = undefined;
    return sessionIndex.markDirty();
  }
  const file = name === 'session.json' ? path.join(path.dirname(full), 'messages.jsonl') : full.replace(/\.json$/, '.jsonl');
  if (!parse(file)) return;
  const before = sessionIndex.records.get(file)?.state?.lines ?? 0;
  sessionIndex.touch(file);
  const rec = sessionIndex.records.get(file);
  if (!rec?.state) return;
  kiro.catalog.advance(file, rec.id, rec.state); // session.json (title, model) changes without new lines
  rec.view = undefined;
  sessionIndex.markDirty();
  void drain(file, before);
  void reportStatus(rec);
}

async function deleteSession(id) {
  await promisify(execFile)(await kiroBin(), ['chat', '--delete-session', id], { timeout: 30_000 });
  return true;
}

const kiroInteraction = defineInteractionAdapter({
  runtime: 'kiro',
  owns: (id) => conns.has(id),
  isBusy: (id) => !!conns.get(id)?.turn,

  async sendExisting({ sessionId, nativeSessionId: id, streamId, text, callbacks }) {
    const cwd = recOf(id)?.state?.cwd;
    if (!cwd) throw new Error('Kiro session not found on this device.');
    let c = conns.get(id);
    // Read after the wait: the first waiter opens the next connection, the others steer into it.
    while (c?.turn?.ending) c = (await c.turn.ended) ?? conns.get(id);
    if (c?.turn) {
      // A prompt during a turn would cancel it; steer adds the message once the turn's prompt is stored.
      const turn = c.turn;
      await turn.sent;
      if (await Promise.race([turn.started.then(() => false), turn.ended.then(() => true)])) throw new Error('The Kiro turn ended; send again.');
      const result = await c.rpc.request('_session/steer', { sessionId: id, message: text, messageId: streamId });
      if (!result?.queued) throw new Error('Kiro did not take the message into the running turn.');
      return;
    }
    if (!c) {
      conns.set(id, c = connect(cwd));
      c.id = id;
      // History comes from the files, so the load does not replay it.
      c.loaded = c.ready.then(() => c.rpc.request('session/load', { sessionId: id, cwd, mcpServers: [], _meta: { kiro: { noReplay: true } } }, { timeoutMs: 60_000 }));
    }
    const turn = newTurn(c, sessionId, streamId, callbacks);
    const file = sessionFile(id);
    if (file && !drains.has(file)) {
      sessionIndex.touch(file);
      drain(file);
    }
    await (turn.sent = c.loaded.then(() => run(c, turn, text), (error) => {
      c.turn = null;
      close(c);
      throw error;
    }));
  },

  async create({ cwd, text, streamId, onCreated }) {
    const c = connect(cwd);
    try {
      await c.ready;
      const result = await c.rpc.request('session/new', { cwd, mcpServers: [] }, { timeoutMs: 60_000 });
      Object.assign(c, { id: result.sessionId, loaded: Promise.resolve(), created: true });
      conns.set(c.id, c);
      // ACP starts at the service default; the user's own default (as the TUI reads it) applies here.
      const model = [path.join(cwd, '.kiro/settings/cli.json'), path.join(HOME, 'settings/cli.json')]
        .map((file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8'))['chat.defaultModel']; } catch { return null; } }).find(Boolean);
      if (result.configOptions?.find((o) => o.id === 'model')?.options?.some((o) => o.value === model)) {
        await c.rpc.request('session/set_config_option', { sessionId: c.id, configId: 'model', value: model });
      }
      const callbacks = await onCreated({ nativeSessionId: c.id, sessionId: sid(c.id) });
      const turn = newTurn(c, sid(c.id), streamId, callbacks);
      turn.sent = Promise.resolve(run(c, turn, text));
    } catch (error) {
      close(c);
      throw error;
    }
  },

  // Kiro ignores a cancel that arrives before the turn starts.
  async interrupt(id) {
    const c = conns.get(id);
    const turn = c?.turn;
    if (!turn) return;
    await c.loaded?.catch(() => {});
    await Promise.race([turn.started, new Promise((resolve) => setTimeout(resolve, 2000))]);
    for (const ask of turn.asks.values()) ask.resolve({ outcome: { outcome: 'cancelled' } });
    turn.asks.clear();
    c.rpc.notify('session/cancel', { sessionId: id });
  },

  replyControl(id, requestId, { decision, scope }) {
    const turn = conns.get(id)?.turn;
    const ask = turn?.asks.get(requestId);
    if (!ask) return false;
    turn.asks.delete(requestId);
    const always = decision === 'allow' && scope === 'session' && ask.grant;
    if (always) grants.add(sid(id), [ask.grant]);
    ask.resolve(ask.pick(always ? 'allow_always' : decision === 'allow' ? 'allow_once' : 'reject_once'));
    return true;
  },

  // Another live client (a terminal, the IDE) holds the session's lease.
  heldElsewhere(id) {
    const lease = readLease(path.join(LEASES, `${id}.lease`));
    if (!lease?.live || lease.clientName === CLIENT) return null;
    return { pid: lease.pid, status: recOf(id)?.state?.open ? 'running' : 'idle', canTerminate: true,
      label: `A Kiro client (${lease.clientName || 'unknown'})` };
  },

  listCommands({ cwd }) {
    // Kiro's own list (agents, Skills, prompts), as the last turn in this folder received it.
    return { commands: (commands.get(cwd) || []).map((c) => ({ name: c.name, source: 'runtime', description: c.description || '',
      argumentHint: c.input?.hint || '', behavior: c.input?.hint ? 'compose' : 'send' })), skills: [] };
  },

  shutdown: () => Promise.all([...conns.values()].map(close)),
});

export default defineRuntimeAdapter({
  ...kiro,
  displayName: 'Kiro',
  features: { create: true, send: true, interrupt: true, deleteHistory: true, statusPolling: true },
  interaction: kiroInteraction,
  watcher: defineRuntimeWatcher({
    runtime: 'kiro',
    // sessions/ (recursive) and session-leases/; their parents, not recursive, only until both exist.
    start(next) {
      config = next;
      // Node's recursive watcher errors when a dir vanishes mid-scan (the TUI's .lock.acquire): drop it, arm again.
      const watch = (key, ...args) => fs.watch(...args).on('error', (error) => {
        console.error(`[kiro] watch ${key}: ${error.message}`);
        watches[key]?.close();
        watches[key] = null;
        setTimeout(arm, 1000).unref();
      });
      const arm = () => {
        if (!watches.sessions && fs.existsSync(ROOT)) {
          watches.sessions = watch('sessions', ROOT, { recursive: true }, (_event, name) => name && changed(path.join(ROOT, name)));
          kiro.catalog.files().forEach(changed); // written before the watch existed
        }
        watches.leases ||= fs.existsSync(LEASES) && watch('leases', LEASES, (_event, name) => name?.endsWith('.lease') && reportStatus(recOf(name.slice(0, -6))));
        // Until both exist: the Kiro home, or its parent while the home itself is missing.
        const dir = watches.sessions && watches.leases ? null : fs.existsSync(HOME) ? HOME : path.dirname(HOME);
        if (watches.home?.dir !== dir) watches.home = (watches.home?.close(), dir && Object.assign(watch('home', dir, arm), { dir }));
      };
      arm();
    },
  }),
  // The catalog comes from the session index.
  discover: () => ({ sessions: [] }),
  findSessionFile: sessionFile,
  baselineToEnd() {},
  deleteSessionHistory: deleteSession,
  async deleteProjectHistory(projectHash) {
    const ids = (sessionIndex.catalog().byProject.get(projectHash) || []).filter((row) => row.rec.runtime === 'kiro').map((row) => row.rec.id);
    // Session deletes are guarded by ws.mjs; a project's are checked here.
    if (ids.some((id) => conns.has(id) || kiroInteraction.heldElsewhere(id))) throw new Error('a Session is in use');
    for (const id of ids) await deleteSession(id);
    return true;
  },
  createStatusContext: () => ({ leases: kiro.catalog.running() }),
  inspectActiveSession(active, { leases }) {
    const rec = recOf(active.nativeSessionId);
    if (!rec || conns.get(rec.id)?.turn) return null;
    const row = sessionRow(rec, kiro.catalog.status(rec, leases, Date.now()));
    return row && row.status !== active.status ? { session: row } : null;
  },
  updateSessionStatus(next, id, filePath, _project, status, detail, context) {
    config = next;
    sessionIndex.touch(filePath);
    const row = recOf(id) && sessionRow(recOf(id), status);
    if (row) context.report(next, [{ ...row, agentDetail: status === 'needs_input' ? detail || row.agentDetail : '' }]);
  },
});
