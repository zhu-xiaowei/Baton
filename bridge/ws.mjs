import WebSocket from 'ws';
import { resolveBridgeAttachments } from './attachments.mjs';
import { setTransferAccess, setTransferKeys, transfer } from './transfer-store.mjs';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { extractForApp, synced, countJsonlLines } from './extract.mjs';
import { toolPreviews } from './tool-preview.mjs';
import {
  projectHashToPath,
  getDaemonRunningSessionIds,
  getAgentsJson,
  requireClaudeBin,
  liveRecordBusy,
  claudeSessionWriter,
} from './session.mjs';
import { parseStorageSessionId, runtimeDescriptor, storageSessionId } from './session-identity.mjs';
import { SessionGrants } from './session-grants.mjs';
import { getRuntimeAdapter, runtimeAdapters } from './runtime-registry.mjs';
import { WS_FRAME_LIMIT, saveConfig, uninstallBridge } from './config.mjs';
import { ClaudePool } from './headless.mjs';
import {
  liveMessageRoute,
  liveMessagePushed,
  markLiveMessagePushed,
  registerClaudeInterruptTurn,
} from './live-message-registry.mjs';
import { post } from './http.mjs';
import { scanSlashCommands } from './commands.mjs';
import {
  capturedClaudeCommandNames,
  claudeCommandCatalog,
  parseClaudeSlashCommand,
} from './claude-commands.mjs';
import { buildClaudeUsagePanel } from './claude-usage.mjs';
import {
  CODEX_INIT_PROMPT,
  codexCommandCatalog,
  expandCodexLegacyPrompt,
  isSupportedCodexCommand,
  parseCodexSlashCommand,
} from './codex-commands.mjs';
import { inspectCodexSession, resolveCodexSessionCwd } from './codex-session.mjs';
import { updateSessionStatus, recentSessions } from './sync.mjs';
import { BRIDGE_VERSION } from './version.mjs';
import {
  PermissionQueue,
  resolvedControlActivity,
} from './permission-queue.mjs';
import { ClaudeHookServer } from './claude-hook.mjs';
import { ActiveTurnRegistry } from './active-turn-registry.mjs';
import { batonSessions } from './presence.mjs';
import { LiveExecutionStream } from './live-execution-stream.mjs';
import {
  assertTurnEventEnvelope,
  isPromptUserMessage,
  LiveTurnStream,
  OPTIONAL_TURN_EVENT_ACTIONS,
  prepareAuthoritativeMessage,
  STREAM_EVENT_ACTIONS,
  shouldCreateFinalInterrupt,
  shouldSendImmediateInterrupt,
} from './live-turn-stream.mjs';
import { CommandCatalogCache, commandCatalogPayload } from './command-catalog-cache.mjs';
import { onAgentCountUpdates } from './agent-counts.mjs';
import { configureNotifier, endTakeover, noteTakeover } from './notify.mjs';
import { ClientTurnOrder } from './client-turn-order.mjs';
import { DirectRpcBridge, SessionSubscribers } from './direct-rpc.mjs';
import { sessionIndex } from './session-index.mjs';
import { historyService } from './history-service.mjs';
import { handleSessionRename, renameNativeSession } from './session-rename.mjs';
import { createProjectDirectory } from './project-path.mjs';
import { toolDetails } from './tool-details.mjs';

let _ws = null;
let _checkUpdate = null;
let _onSuperseded = null;
let _directRpc = null;
let _config = null;
let _reconnectTimer = null;
let _heartbeatTimer = null;
let _heartbeatTimeout = null;
let _pingTimer = null;
let _connectWatchdog = null;
let _resumeProbeTimer = null;
let _pendingPing = null;
let _pingSequence = 0;
let _consecutiveFailures = 0;
const _sendWhenConnected = [];
const HEARTBEAT_INTERVAL = 4 * 60_000;
const HEARTBEAT_TIMEOUT = 10_000;
const PING_INTERVAL = 20_000;
const PING_TIMEOUT = 5_000;
const RECONNECT_DELAY = 5_000;
const CONNECT_TIMEOUT = 5_000;

// onExit only fires when a process exits during an active turn or with prompts unanswered.
const _pool = new ClaudePool({
  trackLeftovers: true,
  allowedTools: (sessionId) => _grants.get(sessionId),
  onExit: (sessionId, hadPrompts) => {
    if (hadPrompts) clearPendingControls(sessionId);
    syncPoolStatus(sessionId, 'completed');
  },
  onControlRequest: (sessionId, req) => queuePermissionRequest(sessionId, req),
});
const _grants = new SessionGrants();
const _claudeRuntime = getRuntimeAdapter('claude');
const _claudeCapturedCommands = new Map();
const _commandCatalogCache = new CommandCatalogCache();
const _clientTurnOrder = new ClientTurnOrder();
const _clientTurnsInFlight = new Set();
const _clientTurnAcks = new Map();
const _sendRequests = new Map(); // turnId → requests waiting for that turn's send_message_result
const _subscribers = new SessionSubscribers();
// Changes when the Bridge restarts: every subscription is gone and the App reloads its history.
const BRIDGE_EPOCH = crypto.randomUUID();
const SESSION_EVENTS = new Set([...STREAM_EVENT_ACTIONS, ...OPTIONAL_TURN_EVENT_ACTIONS]);
// The events of each running turn, so a (re)subscribing App gets the turn from its start instead of
// waiting for the next block. sessionId → Map(turnId → { events, bytes }); a turn over the limit is
// not replayed (the App then waits for its next block, as before).
const _liveTurns = new Map();
const REPLAY_LIMIT = 1024 * 1024;

function rememberTurnEvent(event) {
  if (!event.turnId || !Number.isInteger(event.seq)) return;
  let turns = _liveTurns.get(event.sessionId);
  if (event.action === 'stream_end') {
    turns?.delete(event.turnId);
    if (turns && !turns.size) _liveTurns.delete(event.sessionId);
    return;
  }
  if (!turns) {
    _liveTurns.set(event.sessionId, turns = new Map());
    if (_liveTurns.size > 64) _liveTurns.delete(_liveTurns.keys().next().value);
  }
  let turn = turns.get(event.turnId);
  if (!turn) turns.set(event.turnId, turn = { events: [], bytes: 0 });
  if (turn.bytes > REPLAY_LIMIT) return;
  turn.bytes += JSON.stringify(event).length;
  turn.events = turn.bytes > REPLAY_LIMIT ? [] : [...turn.events, event];
}

// Which requests count against the Bridge's limit of reads that use the machine at once.
const READ_METHODS = new Set(['home', 'projects', 'sessions', 'history', 'threads', 'tool_details']);
const GIT_WRITES = new Set(['stage', 'unstage', 'discard', 'commit', 'push']);
function limitedRequest(frame) {
  if (READ_METHODS.has(frame.method)) return true;
  const operation = frame.params?.operation;
  if (frame.method === 'git_status') return !GIT_WRITES.has(operation);
  return frame.method === 'project_files' && operation !== 'download';
}

// Runs a handler written for the control socket (it calls `send` with reply frames) as a direct
// request: progress frames go out as `rpc_progress`, the rest is the reply `{ frames }`.
async function collectFrames(run, caller) {
  const frames = [];
  await run((frame) => {
    const { action, ...rest } = frame;
    if (rest.progress || rest.pending) caller.progress(rest);
    else frames.push(rest);
    return true;
  });
  return { frames };
}

function replayTurns(sessionId, caller) {
  const events = [...(_liveTurns.get(sessionId)?.values() || [])].flatMap((turn) => turn.events);
  if (events.length) _directRpc?.publish({ action: 'turn_replay', sessionId, events }, [[caller.replyTo, { deflate: caller.deflate }]]);
}
const CLIENT_TURN_ACK_LIMIT = 5000;
let _claudeHookServer = null;
let _projectFilesModule = null;
let _gitStatusModule = null;
let _sharedTerminals = null;
let _sharedTerminalsLoading = null;
let _previewBridge = null;
let _previewBridgeLoading = null;

// A terminal or preview peer's way back to its App page; it outlives a control-socket reconnect
// (which replaces _directRpc). `follow(frame)` keeps it on the page's latest connection and on
// whether that page inflates.
function streamChannel(ch, id, target, deflate = false) {
  const channel = {
    readyState: 1,
    target,
    deflate,
    follow(frame) { channel.target = frame.from; }, // `inflate` comes only with open / start
    get bufferedAmount() { return _directRpc?.bufferedAmount || 0; },
    send(message) {
      if (channel.readyState !== 1) return false;
      void _directRpc?.sendStream(ch, id, channel.target, message, channel.deflate);
      return true;
    },
    close() { channel.readyState = 3; },
  };
  return channel;
}

async function terminalStream(frame) {
  _sharedTerminalsLoading ||= import('./terminal-shared.mjs').then(({ createSharedTerminals }) => {
    _sharedTerminals = createSharedTerminals({ channel: (frame) => streamChannel('terminal', frame.id, frame.from, frame.inflate === 1) });
    return _sharedTerminals;
  }).catch(error => { _sharedTerminalsLoading = null; throw error; });
  try {
    (await _sharedTerminalsLoading).handle(frame);
  } catch {
    streamChannel('terminal', frame.id, frame.from).send({ type: 'error', eventSeq: 0, fatal: true,
      message: 'Terminal components unavailable. Update or reinstall Bridge.' });
  }
}

async function previewStream(frame) {
  _previewBridgeLoading ||= import('./preview-bridge.mjs').then(({ createPreviewBridge }) => {
    _previewBridge = createPreviewBridge({ channel: (frame) => streamChannel('preview', frame.id, frame.from, frame.inflate === 1) });
    return _previewBridge;
  }).catch(error => { _previewBridgeLoading = null; throw error; });
  try {
    (await _previewBridgeLoading).handle(frame);
  } catch {
    streamChannel('preview', frame.id, frame.from).send({ type: 'gone' });
  }
}

async function projectFilesModule() {
  if (!_projectFilesModule) {
    _projectFilesModule = import('./project/files.mjs')
      .catch(() => import('./project-files.mjs'));
  }
  return _projectFilesModule;
}

async function gitStatusModule() {
  if (!_gitStatusModule) {
    _gitStatusModule = import('./project/git.mjs');
  }
  return _gitStatusModule;
}

// Windows updates stop terminal shells first so no ConPTY children outlive the old Bridge.
export async function closeTerminalsForUpdate() {
  const terminals = _sharedTerminals;
  _sharedTerminals = _sharedTerminalsLoading = null;
  if (!terminals) return;
  terminals.dispose();
  await new Promise(resolve => setTimeout(resolve, 1500));
}

// Idle pooled processes do not block terminal-driven status updates.
export function poolOwns(sessionId) { return _pool.isBusy(sessionId); }
export function poolAwaitsAgents(sessionId) { return _pool.awaitsAgents(sessionId); }
// Whether the last root write held its Done for background agents; a released hold is written.
export const heldForAgents = new Map();
// Background agents CC will report back on: a pooled process's task list (its record reads
// idle meanwhile), else CC's own record, which may lag the last row by a moment.
export async function backgroundAgentsLeft(sessionId) {
  if (_pool.owns(sessionId)) return _pool.awaitsAgents(sessionId);
  if (!liveRecordBusy(sessionId)) return false;
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return liveRecordBusy(sessionId);
}

export async function shutdownInteractions() {
  _config = null;
  clearTimeout(_reconnectTimer);
  clearTimeout(_connectWatchdog);
  clearTimeout(_resumeProbeTimer);
  clearTimeout(_heartbeatTimeout);
  clearInterval(_heartbeatTimer);
  clearInterval(_pingTimer);
  const socket = _ws;
  _ws = null;
  if (socket) {
    socket.removeAllListeners();
    socket.on('error', () => {});
    await new Promise(resolve => {
      const timeout = setTimeout(() => { socket.terminate(); resolve(); }, 1500);
      socket.once('close', () => { clearTimeout(timeout); resolve(); });
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'Bridge shutting down');
      else socket.terminate();
    });
  }
  _sharedTerminals?.dispose();
  _previewBridge?.dispose();
  _pool.shutdownAll();
  await _claudeHookServer?.close();
  _claudeHookServer = null;
  await Promise.allSettled(
    runtimeAdapters
      .map((adapter) => adapter.interaction?.shutdown?.())
      .filter(Boolean),
  );
}

// The watcher clears each UUID after its JSONL copy is persisted. Until then this
// ownership marker prevents a second realtime broadcast.
export function markHeadlessPushed(uuid) {
  markLiveMessagePushed('claude', uuid);
}
export function headlessPushed(uuid) { return liveMessagePushed('claude', uuid); }
export function headlessRoute(uuid) { return liveMessageRoute('claude', uuid); }

// Codex may issue several approvals in parallel. Match its TUI: keep the first
// visible and process later requests newest-first.
const _pendingControl = new PermissionQueue();
const _statusSyncs = new Map();
const _activeTurns = new ActiveTurnRegistry();
const _liveExecutions = new Map();
const NEW_SESSION_FILE_WAIT_MS = 30_000;
const SESSION_FILE_POLL_MS = 50;

export async function waitForSessionFile(adapter, nativeSessionId, options = {}) {
  const timeoutMs = options.timeoutMs ?? NEW_SESSION_FILE_WAIT_MS;
  const pollMs = options.pollMs ?? SESSION_FILE_POLL_MS;
  const ready = options.ready || (() => true);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const filePath = adapter.findSessionFile(nativeSessionId);
    if (filePath && ready(filePath)) return filePath;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function cwdForSession(sessionId) {
  const filePath = _claudeRuntime.findSessionFile(sessionId);
  if (!filePath) return null;
  const projectHash = path.basename(path.dirname(filePath));
  return projectHashToPath(projectHash);
}

async function loadCommandCatalog(runtime, cwd, fallbackDir = cwd) {
  let commands = [];
  let skills = [];
  if (runtimeDescriptor(runtime)) return runtimeDescriptor(runtime).interaction.listCommands({ cwd });
  if (runtime === 'codex') {
    const context = await getRuntimeAdapter('codex').interaction.listCommandContext({
      cwd,
      forceReload: true,
    });
    commands = codexCommandCatalog({
      commandOptions: context.commandOptions,
      remoteOptionNames: ['experimental', 'agent', 'subagents'],
    });
    skills = context.skills;
  } else {
    try {
      const context = await _pool.inspect(cwd);
      commands = claudeCommandCatalog(context);
      _claudeCapturedCommands.set(
        cwd,
        capturedClaudeCommandNames(context),
      );
      if (_claudeCapturedCommands.size > 100) {
        _claudeCapturedCommands.delete(_claudeCapturedCommands.keys().next().value);
      }
    } catch (error) {
      console.warn(`[ws] Claude command initialize unavailable, using disk fallback: ${error.message}`);
      _claudeCapturedCommands.delete(cwd);
      commands = scanSlashCommands(fallbackDir);
    }
  }
  return { commands, skills };
}

function commandCatalog(runtime, cwd, fallbackDir = cwd, options = {}) {
  return _commandCatalogCache.get(
    `${runtime}:${cwd}`,
    () => loadCommandCatalog(runtime, cwd, fallbackDir),
    options,
  );
}

// First prompt of Sessions created here, until their transcript names them.
const _sentPrompts = new Map();

// Report an interaction-owned session's status.
function syncInteractionStatus(sessionId, status, detail, runtimeHint, options = {}) {
  const identity = parseStorageSessionId(sessionId, runtimeHint);
  batonSessions.add(identity.nativeSessionId);
  const key = identity.sessionId;
  const previous = _statusSyncs.get(key) || Promise.resolve();
  const next = previous.then(async () => {
    if (status === 'completed') endTakeover(key);
    const adapter = getRuntimeAdapter(identity.runtime);
    let filePath = adapter.findSessionFile(identity.nativeSessionId);
    if (options.waitForFile
      && (!filePath || (options.fileReady && !options.fileReady(filePath)))) {
      filePath = await waitForSessionFile(adapter, identity.nativeSessionId, {
        ready: options.fileReady,
      });
    }
    if (!filePath || !_config) return;
    const projectHash = path.basename(path.dirname(filePath));
    const isNew = !!options.registerNew && !recentSessions.has(key);
    if (isNew) recentSessions.add(key);
    const held = status === 'completed' && poolAwaitsAgents(key);
    try {
      await updateSessionStatus(
        _config,
        identity.sessionId,
        filePath,
        projectHash,
        status,
        detail,
        identity.runtime,
        { isNew, sentPrompt: _sentPrompts.get(key), backgroundAgents: held },
      );
      if (identity.runtime === 'claude') heldForAgents.set(key, held);
      if (status === 'completed') _sentPrompts.delete(key);
    } catch {
      if (isNew) recentSessions.delete(key);
    }
  });
  _statusSyncs.set(key, next);
  next.finally(() => {
    if (_statusSyncs.get(key) === next) _statusSyncs.delete(key);
  });
  return next;
}

function syncPoolStatus(sessionId, status, detail, options) {
  return syncInteractionStatus(sessionId, status, detail, 'claude', options);
}

function controlDetail(p) {
  if (!p) return '';
  const input = p.input || {};
  if (input.codexGoalResume) return input.codexGoalResume.objective || 'Resume goal';
  if (Array.isArray(input.questions) && input.questions.length) return input.questions[0].question || '';
  if (p.toolName === 'ExitPlanMode' || p.toolName === 'exit_plan_mode') return 'Review plan';
  return input.command || input.file_path || input.path || p.toolName || '';
}

export function pendingInteractionDetail(sessionId) {
  const pending = _pendingControl.current(sessionId);
  return pending ? controlDetail(pending) : null;
}

function permissionKind(p) {
  if (!p.requiresInteraction) return 'tool';
  return p.toolName === 'ExitPlanMode' || p.toolName === 'exit_plan_mode' ? 'plan' : 'ask';
}

function sendPermissionRequest(sessionId, p) {
  const payload = {
    kind: permissionKind(p),
    requestId: p.requestId,
    toolName: p.toolName,
    approvalType: p.approvalType || null,
    questions: p.input.questions,
    plan: p.input.plan,
    input: p.input,
    ...(p.sessionScope ? { sessionScope: { label: p.sessionScope.label } } : {}),
  };
  if (p.liveTurn && !p.liveTurn.isEnded()) {
    p.liveTurn.emit('permission_request', payload);
  } else {
    wsSend({ action: 'permission_request', sessionId, ...payload });
  }
}

function sendPermissionResolved(sessionId, p, activity = '') {
  const payload = {
    requestId: p.requestId,
    ...(activity ? { activity } : {}),
  };
  if (p.liveTurn && !p.liveTurn.isEnded()) {
    p.liveTurn.emit('permission_resolved', payload);
  } else {
    wsSend({ action: 'permission_resolved', sessionId, ...payload });
  }
}

function clearPendingControls(sessionId) {
  const cleared = _pendingControl.clear(sessionId);
  if (cleared?.current) {
    sendPermissionResolved(sessionId, cleared.current);
  }
}

function dismissPendingControl(sessionId, requestId) {
  const dismissed = _pendingControl.dismiss(sessionId, requestId);
  if (!dismissed || dismissed.current) return;
  sendPermissionResolved(sessionId, dismissed.resolved);
  if (dismissed.next) {
    sendPermissionRequest(sessionId, dismissed.next);
  }
  const statusTarget = dismissed.next || dismissed.resolved;
  if (statusTarget.syncStatus) {
    syncInteractionStatus(
      sessionId,
      dismissed.next ? 'needs_input' : 'running',
      controlDetail(dismissed.next),
      statusTarget.runtime,
    );
  }
}

// CC suggests rules for "don't ask again" (for the project); Baton keeps them for this Session only.
function claudeSessionScope(r) {
  const rules = (r.permission_suggestions || []).filter((s) => s.type === 'addRules' && s.behavior === 'allow')
    .flatMap((s) => s.rules || []);
  if (r.requires_user_interaction || !rules.length) return null;
  const grants = rules.map((rule) => (rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName));
  return { label: grants.join(', '), rules, grants };
}

function queuePermissionRequest(sessionId, req, options = {}) {
  const r = req.request || {};
  const input = r.input || {};
  const syncStatus = options.syncStatus !== false && r.sync_status !== false;
  const queued = _pendingControl.enqueue(sessionId, {
    requestId: req.request_id,
    toolName: r.tool_name,
    input,
    requiresInteraction: !!r.requires_user_interaction,
    approvalType: r.approval_type || null,
    runtime: options.runtime || 'claude',
    nativeSessionId: options.nativeSessionId || sessionId,
    syncStatus,
    sessionScope: claudeSessionScope(r),
    ...(options.liveTurn ? { liveTurn: options.liveTurn } : {}),
  });
  if (queued.current.syncStatus) {
    syncInteractionStatus(
      sessionId,
      'needs_input',
      controlDetail(queued.current),
      options.runtime,
    );
  }
  if (queued.shouldPresent) sendPermissionRequest(sessionId, queued.current);
  return queued;
}

function permissionObservationCallbacks(sessionId, identity) {
  return {
    onControlRequest: (req) => queuePermissionRequest(sessionId, req, {
      runtime: identity.runtime,
      nativeSessionId: identity.nativeSessionId,
    }),
    onControlResolved: (requestId) => {
      dismissPendingControl(sessionId, requestId);
    },
  };
}

// Sends a Session's waiting prompt to its subscribers again. `observe` also lets the runtime
// adopt approvals that are waiting outside this Bridge (Codex); a lease renewal skips that.
async function handleRevealPermission(sessionId, observe = true) {
  if (!sessionId) return;
  const pending = _pendingControl.current(sessionId);
  if (pending) {
    if (pending.syncStatus && observe) {
      syncInteractionStatus(
        sessionId,
        'needs_input',
        controlDetail(pending),
        pending.runtime,
      );
    }
    sendPermissionRequest(sessionId, pending);
    return;
  }
  if (!observe) return;
  const identity = parseStorageSessionId(sessionId);
  const adapter = getRuntimeAdapter(identity.runtime);
  if (typeof adapter.interaction?.observePermissions !== 'function') return;
  await adapter.interaction.observePermissions({
    sessionId: identity.sessionId,
    nativeSessionId: identity.nativeSessionId,
    callbacks: permissionObservationCallbacks(identity.sessionId, identity),
    goalCallbacks: goalContinuationCallbacks(identity),
  });
}

function handleClaudeHookRequest(input, reply) {
  const sessionId = input.session_id;
  const toolName = input.tool_name;
  const toolUseId = input.tool_use_id;
  if (!sessionId || !toolName || !toolUseId) {
    reply({ action: 'pass' });
    return null;
  }

  const requestId = `hook:${toolUseId}`;
  const requiresInteraction = toolName === 'AskUserQuestion'
    || toolName === 'ExitPlanMode'
    || toolName === 'exit_plan_mode';
  const queued = _pendingControl.enqueue(sessionId, {
    requestId,
    toolName,
    input: input.tool_input || {},
    requiresInteraction,
    runtime: 'claude',
    nativeSessionId: sessionId,
    syncStatus: true,
    hookReply: reply,
  });
  syncInteractionStatus(sessionId, 'needs_input', controlDetail(queued.current), 'claude');
  if (queued.shouldPresent) sendPermissionRequest(sessionId, queued.current);
  return () => dismissPendingControl(sessionId, requestId);
}

export function setUpdateChecker(checkUpdate) {
  _checkUpdate = checkUpdate;
}

export function initWs(config, options = {}) {
  _config = config;
  _onSuperseded = options.onSuperseded || null;
  if (!_claudeHookServer) {
    _claudeHookServer = new ClaudeHookServer({ onRequest: handleClaudeHookRequest });
    _claudeHookServer.start()
      .then(() => console.log('[hook] Claude relay ready'))
      .catch((error) => {
        console.log(`[hook] Claude relay unavailable: ${error.message}`);
        _claudeHookServer = null;
      });
  }
  connect();
}

// codex_writer_changed/unsafe stay cached as before; every other runtime's conflicts are retried.
const WRITER_CONFLICT = /^(?!codex_writer_)\w+_(active_writer|writer_changed|writer_unsafe)$/;

export function shouldCacheClientTurnAck(data) {
  return data?.action === 'send_message_result'
    && !!data.turnId
    && !data.queued
    && data.errorCode !== 'previous_turn_missing'
    && !WRITER_CONFLICT.test(data.errorCode || '');
}

export function wsSend(data) {
  assertTurnEventEnvelope(data);
  if (shouldCacheClientTurnAck(data)) {
    _clientTurnAcks.delete(data.turnId);
    _clientTurnAcks.set(data.turnId, { ...data });
    while (_clientTurnAcks.size > CLIENT_TURN_ACK_LIMIT) {
      _clientTurnAcks.delete(_clientTurnAcks.keys().next().value);
    }
  }
  if (data?.action === 'send_message_result' && _sendRequests.has(data.turnId)) {
    const { action, ...result } = data;
    settleSendRequests(result);
    return true;
  }
  if (data?.sessionId && SESSION_EVENTS.has(data.action)) {
    // Session events go to the Apps subscribed to them, never through the server.
    rememberTurnEvent(data);
    _directRpc?.publish(data);
    return true;
  }
  if (!_ws || _ws.readyState !== WebSocket.OPEN) return false;
  try {
    const payload = JSON.stringify(data);
    if (Buffer.byteLength(payload) > WS_FRAME_LIMIT) {
      console.error(`[ws] dropped oversized ${data.action || 'event'}`);
      return false;
    }
    _ws.send(payload);
    return true;
  } catch {
    return false;
  }
}

export function wsSendWhenConnected(data) {
  if (wsSend(data)) return true;
  _sendWhenConnected.push(data);
  return false;
}

// Rows read from a transcript, pushed to the Session's subscribers.
export function publishMessages(sessionId, messages) {
  if (messages.length) wsSend({ action: 'messages', sessionId, messages: toolPreviews(messages) });
}

function probeConnection() {
  const socket = _ws;
  if (!socket || socket.readyState !== WebSocket.OPEN || _resumeProbeTimer !== null) return;
  const timeout = _resumeProbeTimer = setTimeout(() => {
    if (_ws !== socket || _resumeProbeTimer !== timeout) return;
    console.log(`[ws] ping timed out after ${PING_TIMEOUT}ms, reconnecting`);
    scheduleReconnect();
  }, PING_TIMEOUT);
  _pendingPing = String(++_pingSequence);
  try { socket.ping(_pendingPing); } catch (error) {
    console.error(`[ws] ping failed: ${error.message}`);
    scheduleReconnect();
  }
}

function sendHeartbeat() {
  const socket = _ws;
  if (!socket || socket.readyState !== WebSocket.OPEN || _heartbeatTimeout !== null) return;
  const timeout = _heartbeatTimeout = setTimeout(() => {
    if (_ws !== socket || _heartbeatTimeout !== timeout) return;
    console.log(`[ws] heartbeat timed out after ${HEARTBEAT_TIMEOUT}ms, reconnecting`);
    scheduleReconnect();
  }, HEARTBEAT_TIMEOUT);
  try { socket.send(JSON.stringify({ action: 'heartbeat' })); } catch (error) {
    console.error(`[ws] heartbeat failed: ${error.message}`);
    scheduleReconnect();
  }
}

function connect() {
  if (!_config?.wsUrl) return;
  if (_ws?.readyState === WebSocket.OPEN || _ws?.readyState === WebSocket.CONNECTING) return;
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  resetConnection();
  const wsUrl = _config.wsUrl;

  const url = `${wsUrl}?apiKey=${_config.apiKey}&role=bridge&heartbeat=${HEARTBEAT_INTERVAL / 1000}`
    + `&device=${encodeURIComponent(_config.deviceName)}`
    + `&name=${encodeURIComponent(_config.deviceDisplayName || _config.deviceName)}&os=${process.platform}`
    + (_config.bridgeId ? `&bridgeId=${encodeURIComponent(_config.bridgeId)}` : '')
    + `&version=${encodeURIComponent(BRIDGE_VERSION)}`;
  console.log(`[ws] connecting to ${wsUrl}...`);

  // Use the system resolver (default). A custom dns.resolve4 lookup was tried
  // here but it bypasses split-horizon/VPN DNS config and returns unreachable
  // public IPs (varying each call), causing WS handshake timeouts.
  const socket = _ws = new WebSocket(url, { handshakeTimeout: CONNECT_TIMEOUT });

  _connectWatchdog = setTimeout(() => {
    if (_ws === socket && socket.readyState !== WebSocket.OPEN) {
      console.log('[ws] connect timeout, forcing reconnect...');
      scheduleReconnect();
    }
  }, CONNECT_TIMEOUT);

  socket.on('open', () => {
    if (_ws !== socket) return;
    if (_connectWatchdog) { clearTimeout(_connectWatchdog); _connectWatchdog = null; }
    console.log('[ws] connected');
    const send = payload => {
      if (socket !== _ws || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 1024 * 1024) return false;
      socket.send(payload);
      return true;
    };
    _directRpc = new DirectRpcBridge({
      key: _config.apiKey,
      accountKey: _config.accountKey ? Buffer.from(_config.accountKey, 'base64') : null,
      accountKeyAt: _config.accountKeyAt,
      saveAccountKey: (raw) => { Object.assign(_config, { accountKey: raw.toString('base64'), accountKeyAt: Date.now() }); saveConfig(_config); },
      sendControl: message => send(JSON.stringify(message)),
      subscribers: _subscribers,
      limited: limitedRequest,
      streams: { terminal: terminalStream, preview: previewStream },
      handlers: {
        home: params => { historyService.warm(); return sessionIndex.home(params.revision); },
        projects: params => sessionIndex.projects(params),
        sessions: params => sessionIndex.sessions(params),
        // Subscribing here, before the file is read, leaves no gap between the page and the pushes.
        // With `subscribe` this also does what opening with `subscribe` does, before the file is
        // read, so nothing falls between the page and the pushes.
        history: async (params, caller) => {
          // A refresh of an open page only renews its lease; the replay and prompt are for opening.
          if (params.subscribe && _subscribers.has(params.sessionId, caller.replyTo)) _subscribers.add(params.sessionId, caller.replyTo, caller.deflate, params.rootSessionId);
          else if (params.subscribe) subscribeCaller(params, caller);
          const reply = await historyService.history(params);
          if (reply.preview && !_catalogTitles.has(params.sessionId)) _catalogTitles.set(params.sessionId, reply.preview);
          return params.subscribe ? { ...reply, bridgeEpoch: BRIDGE_EPOCH } : reply;
        },
        subscribe: (params, caller) => subscribeCaller(params, caller),
        notify_seen: params => { _notifyChecks.get(params.eventId)?.(true); return {}; },
        unsubscribe: (params, caller) => { _subscribers.remove(params.sessionId, caller.replyTo); if (!_subscribers.targets(params.sessionId, { root: true }).length) _catalogTitles.delete(params.sessionId); return {}; },
        send_message: (params, caller) => requestSendMessage(params, caller),
        interrupt: async params => { await handleInterrupt(params); return { ok: true }; },
        permission_reply: params => { handlePermissionReply(params); return { ok: true }; },
        threads: params => historyService.threads(params),
        tool_details: async params => { await sessionIndex.readyPromise; return toolDetails(params, id => historyService.resolve(id)); },
        list_commands: params => listCommands(params),
        list_command_options: params => listCommandOptions(params),
        project_files: async (params, caller) => {
          const { handleProjectFilesMessage } = await projectFilesModule();
          return collectFrames((send) => handleProjectFilesMessage({ ...params, action: 'project_files' }, { send }), caller);
        },
        git_status: async (params, caller) => {
          const { handleGitStatusMessage } = await gitStatusModule();
          return collectFrames((send) => handleGitStatusMessage({ ...params, action: 'git_status' }, { send }), caller);
        },
        rename_session: (params, caller) => collectFrames((send) => handleSessionRename(params, {
          deviceName: _config.deviceName, send: (reply) => { send(reply); if (reply.ok) publishTitle(reply); },
          rename: message => renameNativeSession(message, { claudePool: _pool }),
        }), caller),
        create_project: params => createProject(params.projectPath, params.asAgent),
        delete_files: (params, caller) => collectFrames((send) => handleDeleteFiles({ ...params, progress: true }, { send }), caller),
        ping: () => ({ bridgeVersion: BRIDGE_VERSION, runtimes: runtimeAdapters.filter(adapter => adapter.features.create).map(adapter => adapter.runtime) }),
      },
    });
    _directRpc.start();
    void _checkUpdate?.();
    _heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
    _pingTimer = setInterval(probeConnection, PING_INTERVAL);
    probeConnection();
    sendHeartbeat();
    while (_sendWhenConnected.length > 0) {
      const queued = _sendWhenConnected.shift();
      if (!wsSend(queued)) {
        _sendWhenConnected.unshift(queued);
        break;
      }
    }
  });

  socket.on('pong', data => {
    if (_ws !== socket || data.toString() !== _pendingPing) return;
    clearTimeout(_resumeProbeTimer);
    _resumeProbeTimer = null;
    _pendingPing = null;
  });

  socket.on('message', async (data) => {
    if (_ws !== socket) return;
    try {
      const msg = JSON.parse(data.toString());
      if (msg.action === 'heartbeat') {
        _consecutiveFailures = 0;
        clearTimeout(_heartbeatTimeout);
        _heartbeatTimeout = null;
      }
      await handleMessage(msg);
    } catch (err) {
      console.error(`[ws] message error: ${err.message}`);
    }
  });

  socket.on('close', (code, reason) => {
    if (_ws !== socket) return;
    console.log(`[ws] disconnected (code=${code}, reason=${reason?.toString() || ''}), reconnecting...`);
    scheduleReconnect();
  });

  socket.on('error', (err) => {
    if (_ws !== socket) return;
    console.error(`[ws] error: ${err.message} (code: ${err.code}, type: ${err.type})`);
    scheduleReconnect();
  });

  socket.on('unexpected-response', (_req, res) => {
    if (_ws !== socket) return;
    console.error(`[ws] unexpected-response: ${res.statusCode}`);
    let body = '';
    res.on('data', (chunk) => body += chunk);
    res.on('end', () => {
      if (_ws !== socket) return;
      console.error(`[ws] response body: ${body.slice(0, 200)}`);
      scheduleReconnect();
    });
  });
}

function resetConnection() {
  clearTimeout(_resumeProbeTimer);
  _resumeProbeTimer = null;
  _pendingPing = null;
  clearTimeout(_heartbeatTimeout);
  _heartbeatTimeout = null;
  clearTimeout(_connectWatchdog);
  _connectWatchdog = null;
  clearInterval(_heartbeatTimer);
  _heartbeatTimer = null;
  clearInterval(_pingTimer);
  _pingTimer = null;
  const socket = _ws;
  _ws = null;
  if (socket) {
    socket.removeAllListeners();
    socket.on('error', () => {});
    socket.terminate();
  }
  _directRpc?.dispose();
  _directRpc = null;
}

function scheduleReconnect() {
  if (!_config) return;
  resetConnection();
  if (_reconnectTimer) return;
  _consecutiveFailures += 1;
  const delay = _consecutiveFailures === 1 ? 0 : RECONNECT_DELAY;
  console.log(`[ws] retry ${_consecutiveFailures} in ${delay}ms`);
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    connect();
  }, delay);
}

async function handleMessage(msg) {
  if (_directRpc?.handleControl(msg)) return;
  switch (msg.action) {
    case 'device_removed':
      uninstallBridge();
      console.log('[ws] this device was removed from Baton and autostart is off; run a new install command from Setup to add it again');
      // falls through: stop exactly like a replaced Bridge
    case 'bridge_replaced':
      if (msg.action === 'bridge_replaced') console.log('[ws] replaced by another Bridge for this device; stopping reconnects');
      _config = null;
      clearTimeout(_reconnectTimer);
      _reconnectTimer = null;
      resetConnection();
      await _onSuperseded?.();
      break;
    case 'heartbeat':
      if (typeof msg.bridgeVersion === 'string' && msg.bridgeVersion
        && msg.bridgeVersion !== 'dev' && msg.bridgeVersion !== BRIDGE_VERSION) {
        await _checkUpdate?.();
      }
      break;
    default:
      console.log(`[ws] unknown action: ${msg.action}`);
  }
}

function subscribeCaller(params, caller) {
  if (params.replaces) _subscribers.remove(params.sessionId, params.replaces); // the caller's connection before it reconnected
  _subscribers.add(params.sessionId, caller.replyTo, caller.deflate, params.rootSessionId);
  handleRevealPermission(params.sessionId, !params.renew).catch(error => console.error(`[ws] permission reveal failed: ${error.message}`));
  if (!params.renew) replayTurns(params.sessionId, caller);
  return { epoch: BRIDGE_EPOCH };
}

// A renamed Session's title goes to the pages that show it (lists see it on their next load).
function publishTitle(reply) {
  const event = { action: 'session_title_changed', sessionId: reply.sessionId, projectHash: reply.projectHash,
    device: reply.device, name: reply.name };
  _directRpc?.publish(event, _subscribers.targets(reply.sessionId, { root: true }));
}

// A changed catalog title (generated, or renamed outside Baton) goes to every page showing the Session.
// Sessions enter on their first history read (Claude's never do: its titles arrive as rows).
const _catalogTitles = new Map(); // root sessionId → catalog title at the last check
let _titleCheck = null;
sessionIndex.onDirty = () => { if (_subscribers.sessions.size) _titleCheck ||= setTimeout(publishCatalogTitles, 500); };
function publishCatalogTitles() {
  _titleCheck = null;
  const { roots } = sessionIndex.catalog();
  for (const [sessionId, name] of _catalogTitles) {
    if (!_subscribers.targets(sessionId, { root: true }).length) { _catalogTitles.delete(sessionId); continue; }
    const row = roots.find((r) => r.sessionId === sessionId);
    if (!row?.preview || row.preview === name || !_config) continue;
    _catalogTitles.set(sessionId, row.preview);
    publishTitle({ sessionId, projectHash: row.project, device: _config.deviceName, name: row.preview });
  }
}

sessionIndex.pendingDetail = pendingInteractionDetail;
sessionIndex.awaitsAgents = poolAwaitsAgents;

// "Being viewed": a page showing the root answers `notify_check` with `notify_seen` while it is
// visible and focused. A suspended iOS page keeps its subscription but cannot answer.
const NOTIFY_VIEW_WAIT_MS = 3000;
const _notifyChecks = new Map(); // eventId → settle
function viewedOnApp(rootSessionId, eventId) {
  const targets = _subscribers.targets(rootSessionId, { root: true });
  if (!targets.length || !_directRpc) return Promise.resolve(false);
  return new Promise((resolve) => {
    const settle = (seen) => { clearTimeout(timer); _notifyChecks.delete(eventId); resolve(seen); };
    const timer = setTimeout(() => settle(false), NOTIFY_VIEW_WAIT_MS);
    _notifyChecks.set(eventId, settle);
    _directRpc.publish({ action: 'notify_check', rootSessionId, eventId }, targets);
  });
}
configureNotifier({ post, history: params => historyService.history(params), viewed: viewedOnApp,
  notifyKey: () => _directRpc?.keys?.notifyKey });
setTransferKeys(() => _directRpc?.keys?.files() || null);
setTransferAccess(() => {
  if (!_directRpc) throw new Error('File storage is unavailable');
  return _directRpc.storageAccess();
});

// A root's child counts changed: the pages showing that root refresh their thread list.
onAgentCountUpdates((updates) => {
  for (const update of updates) {
    const root = { projectHash: update.project, rootSessionId: update.sessionId, agentCount: Math.max(0, update.agentCount),
      runningAgentCount: Math.max(0, update.runningAgentCount || 0), needsInputAgentCount: Math.max(0, update.needsInputAgentCount || 0) };
    _directRpc?.publish({ action: 'session_threads_changed', deviceName: _config?.deviceName || '', roots: [root] },
      _subscribers.targets(update.sessionId, { root: true }));
  }
});

// A direct `send_message` request. Its reply is the turn's send_message_result, which wsSend hands
// back; a repeated turnId gets the stored result and never starts a second turn.
function requestSendMessage(msg, caller) {
  if (!msg.turnId || !msg.text || (!msg.sessionId && !msg.projectHash)) throw new Error('Invalid message.');
  if (msg.sessionId) _subscribers.add(msg.sessionId, caller.replyTo, caller.deflate);
  return new Promise((resolve) => {
    _sendRequests.set(msg.turnId, [...(_sendRequests.get(msg.turnId) || []), { resolve, ...caller }]);
    if (_clientTurnAcks.has(msg.turnId)) return void wsSend({ ..._clientTurnAcks.get(msg.turnId) });
    if (_clientTurnsInFlight.has(msg.turnId)) return;
    _clientTurnsInFlight.add(msg.turnId);
    _clientTurnOrder.run(msg, () => handleSendMessage(msg.sessionId, msg.text, msg.projectHash, msg.requestId,
      msg.asAgent, msg.turnId, msg.runtime, msg.takeover, msg.expectedWriterPid))
      .catch((error) => {
        const missing = error?.code === 'previous_turn_missing';
        console.error(`[ws] send failed: ${error.message}`);
        // Not through wsSend: an unexpected failure must not be stored as this turn's result.
        settleSendRequests({ sessionId: msg.sessionId, requestId: msg.requestId, turnId: msg.turnId, ok: false,
          error: missing ? 'Previous message did not reach the Bridge.' : error.message,
          ...(missing ? { errorCode: error.code } : {}) });
      })
      .finally(() => _clientTurnsInFlight.delete(msg.turnId));
  });
}

function settleSendRequests(result) {
  for (const request of _sendRequests.get(result.turnId) || []) {
    // The sender watches the Session it sent to; for a new Session this is its first subscription.
    if (result.ok && result.sessionId) _subscribers.add(result.sessionId, request.replyTo, request.deflate);
    request.resolve(result);
  }
  _sendRequests.delete(result.turnId);
}

async function handleInterrupt(msg) {
  const identity = parseStorageSessionId(msg.sessionId, msg.runtime);
  const adapter = getRuntimeAdapter(identity.runtime);
  if (!adapter.features.interrupt) return;
  let liveInterrupt = false;
  if (msg.turnId && shouldSendImmediateInterrupt(identity.runtime)) {
    liveInterrupt = _activeTurns.get(identity.sessionId, msg.turnId)?.sendInterrupt() || false;
  }
  if (identity.runtime === 'claude' && liveInterrupt) registerClaudeInterruptTurn(identity.sessionId, msg.turnId);
  await (adapter.interaction?.interrupt
    ? adapter.interaction.interrupt(identity.nativeSessionId)
    : _pool.interrupt(identity.nativeSessionId));
}

async function handleSendMessage(
  sessionId,
  text,
  projectHash,
  requestId,
  asAgent,
  turnId,
  runtime,
  takeover,
  expectedWriterPid,
) {
  if (!text) return;
  if (!sessionId && !projectHash) return;
  const identity = parseStorageSessionId(sessionId || '', runtime);
  if (sessionId) batonSessions.add(identity.nativeSessionId);
  const adapter = getRuntimeAdapter(identity.runtime);
  const allowed = sessionId ? adapter.features.send : adapter.features.create;
  if (!allowed) {
    wsSend({
      action: 'send_message_result',
      sessionId,
      ok: false,
      error: sessionId
        ? `${adapter.displayName} sessions are read-only in this Bridge version.`
        : `${adapter.displayName} session creation is unavailable.`,
      requestId,
      turnId,
    });
    return;
  }
  const reservedTurnId = sessionId
    ? resolveTurnId(identity.sessionId, turnId)
    : null;

  let resolved;
  try {
    resolved = await resolveBridgeImages(await resolveBridgeAttachments(text));
  } catch (error) {
    wsSend({
      action: 'send_message_result', ok: false, sessionId, requestId, turnId,
      error: error.message,
    });
    return;
  }
  let routedText = resolved;
  let projectCwd = typeof projectHash === 'string' && projectHash
    ? projectHashToPath(projectHash)
    : null;

  if (identity.runtime === 'codex' && sessionId) {
    try {
      projectCwd = resolveCodexSessionCwd(identity.nativeSessionId);
    } catch (error) {
      wsSend({
        action: 'send_message_result', ok: false, sessionId, requestId, turnId,
        error: error.message,
      });
      return;
    }
  }

  if (identity.runtime === 'codex') {
    const command = parseCodexSlashCommand(resolved);
    if (command) {
      if (command.name.startsWith('prompts:')) {
        try {
          const expanded = expandCodexLegacyPrompt(resolved);
          if (expanded != null) routedText = expanded;
        } catch (error) {
          wsSend({
            action: 'send_message_result',
            sessionId,
            ok: false,
            error: error.message,
            requestId,
            turnId,
          });
          return;
        }
      } else if (command.name === 'init') {
        routedText = CODEX_INIT_PROMPT;
      } else if (sessionId && isSupportedCodexCommand(command.name)) {
        await handleCodexCommand(
          adapter,
          identity,
          command,
          turnId,
          {
            cwd: projectCwd,
            takeover: !!takeover,
            expectedWriterPid,
            reservedTurnId,
          },
        );
        return;
      } else {
        wsSend({
          action: 'send_message_result',
          sessionId,
          ok: false,
          error: sessionId
            ? `Unsupported Codex command on mobile: /${command.name}`
            : `/${command.name} requires an existing Codex session.`,
          requestId,
          turnId,
        });
        return;
      }
    }
  }

  if (identity.runtime === 'claude' && sessionId) {
    const command = parseClaudeSlashCommand(resolved);
    const commandCwd = projectCwd || cwdForSession(identity.nativeSessionId);
    const resolvedCommandCwd = commandCwd ? path.resolve(commandCwd) : '';
    if (command && resolvedCommandCwd && !_claudeCapturedCommands.has(resolvedCommandCwd)) {
      await commandCatalog('claude', resolvedCommandCwd).catch(() => {});
    }
    const captured = resolvedCommandCwd
      ? _claudeCapturedCommands.get(resolvedCommandCwd)
      : null;
    if (command && captured?.has(command.name)) {
      await handleClaudeCommand(
        identity,
        command,
        turnId,
        projectHash,
        reservedTurnId,
      );
      return;
    }
  }

  // Existing session: route through the runtime interaction adapter when available.
  if (sessionId) {
    const handled = adapter.interaction
      ? await handleAdapterSend(
        adapter,
        identity,
        routedText,
        turnId,
        {
          cwd: projectCwd,
          takeover: !!takeover,
          expectedWriterPid,
          reservedTurnId,
        },
      )
      : await handleHeadlessSend(
        identity.nativeSessionId,
        resolved,
        turnId,
        projectHash,
        reservedTurnId,
        { takeover: !!takeover, expectedWriterPid },
      );
    if (handled) return;
    wsSend({ action: 'send_message_result', sessionId, ok: false, error: 'Session unavailable.', turnId });
    return;
  }

  // New session (projectHash only): dispatch creation through the selected runtime.
  const cwd = projectCwd || projectHashToPath(projectHash);
  if (!cwd) {
    wsSend({
      action: 'send_message_result',
      ok: false,
      error: 'Project path not found.',
      requestId,
      turnId,
    });
    return;
  }
  // Project dir deleted/never-existed → recreate so the runtime can spawn there.
  try { if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true }); } catch {}
  if (identity.runtime === 'claude' && asAgent) {
    const r = await newAgentSession(cwd, routedText);
    wsSend({
      action: 'send_message_result',
      ok: r.ok,
      sessionId: r.sessionId,
      error: r.error,
      requestId,
      turnId,
    });
  } else if (adapter.interaction?.create) {
    await newAdapterSession(
      adapter,
      cwd,
      routedText,
      requestId,
      turnId,
    );
  } else {
    await newRegularSession(
      cwd,
      routedText,
      requestId,
      turnId,
    );
  }
}

// Replace baton-bridge: image refs with downloaded local paths CC's Read can open.
async function resolveBridgeImages(text) {
  const imgPattern = /!\[.*?\]\(baton-bridge:(.+?)\)/g;
  let resolved = text;
  let match;
  while ((match = imgPattern.exec(text)) !== null) {
    const localPath = await downloadBridgeImage(match[1]);
    if (localPath) resolved = resolved.replace(match[0], `![](${localPath})`);
  }
  return resolved;
}

const newTurnId = () => (crypto.randomUUID
  ? crypto.randomUUID()
  : 'sd-' + Date.now() + '-' + Math.random().toString(36).slice(2));

function resolveTurnId(sessionId, requestedTurnId = '') {
  if (!sessionId) throw new Error('sessionId is required');
  return requestedTurnId || newTurnId();
}

// Create one strictly identified live turn before the runtime can emit frames.
export function createStreamCallbacks(sessionId, turnId, cwd, ack, options = {}) {
  const steer = options.userInitiated && options.steer !== false;
  const existing = steer && _liveExecutions.get(sessionId);
  if (existing && !existing.liveTurn.isEnded()) {
    existing.liveTurn.registerInput(turnId, ack);
    return existing;
  }
  const segmentIds = new Set([turnId]);
  // A Goal continuation has no input of its own, but a message sent during it
  // is steered into the same Codex turn, so it must join this execution.
  const execution = steer || options.goalContinuation === true;
  const Stream = execution ? LiveExecutionStream : LiveTurnStream;
  const liveTurn = new Stream({
    sessionId,
    turnId,
    goalContinuation: options.goalContinuation,
    send: wsSendWhenConnected,
    onSegment: (id, segment) => {
      segmentIds.add(id);
      _activeTurns.register(sessionId, id, segment);
    },
  });
  if (steer) liveTurn.registerInput(turnId, ack);
  _activeTurns.register(sessionId, turnId, liveTurn);
  const ownsUserPrompt = !steer && (options.runtime || 'claude') === 'claude'
    && typeof options.userText === 'string'
    && !!options.userText.trim();
  if (ownsUserPrompt) {
    liveTurn.sendTransientUser(options.userText);
  }
  const discardTurn = () => {
    for (const id of segmentIds) _activeTurns.discard(sessionId, id);
    if (_liveExecutions.get(sessionId)?.liveTurn === liveTurn) _liveExecutions.delete(sessionId);
  };
  const finishTurn = (end = {}) => {
    liveTurn.sendEnd(end);
    if (liveTurn.isEnded()) discardTurn();
  };
  let authorityQueue = Promise.resolve();
  const publishAuthority = async (raw, meta = {}) => {
    const msg = await prepareAuthoritativeMessage(raw, {
      normalized: meta.normalized,
      normalize: (message) => extractForApp(message, cwd),
    });
    if (!msg) return;
    if (ownsUserPrompt && isPromptUserMessage(msg)) return;
    if (meta.runtime && meta.liveKey) {
      markLiveMessagePushed(meta.runtime, meta.liveKey);
    } else {
      markHeadlessPushed(msg.uuid);
    }
    liveTurn.sendAuthoritative(msg);
  };
  const enqueue = (operation) => {
    authorityQueue = authorityQueue
      .then(operation)
      .catch((error) => {
        console.log(`[ws] live message extract failed: ${error.message}`);
      });
    return authorityQueue;
  };
  const callbacks = {
    liveTurn,
    onAccepted: () => {
      if (options.syncStatus !== false) {
        syncInteractionStatus(sessionId, 'running', '', options.runtime);
      }
    },
    onDelta: (sid, chunk, blockId) => {
      enqueue(() => liveTurn.sendDelta({ chunk, blockId }));
    },
    onInputDelta: (sid, chunk, blockId) => {
      enqueue(() => liveTurn.sendToolInput({ chunk, blockId }));
    },
    onBlockStart: (sid, blockId, kind, name) => {
      enqueue(() => liveTurn.sendBlockStart({ blockId, kind, name }));
    },
    onBlockStop: (sid, blockId) => {
      enqueue(() => liveTurn.sendBlockStop({ blockId }));
    },
    // Full authoritative row; the watcher skips its JSONL copy. App dedupes by uuid.
    onMessage: (sid, raw, meta = {}) => enqueue(() => publishAuthority(raw, meta)),
    onInputConsumed: (ids) => enqueue(() => liveTurn.consumeInputs?.(ids)),
    onResult: (sid, result) => {
      enqueue(() => {
        if ((options.runtime || 'claude') !== 'claude') clearPendingControls(sessionId);
        const interrupted = !result.interruptAuthority
          && shouldCreateFinalInterrupt(options.runtime, result);
        finishTurn({
          error: result.is_error ? (result.subtype || 'error') : undefined,
          interrupted,
          consumedInputIds: result.consumedInputIds,
          continued: result.continued,
        });
        // A turn awaiting a permission reply stays needs_input; otherwise the turn is done.
        if (options.syncStatus !== false) {
          syncInteractionStatus(
            sessionId,
            _pendingControl.has(sessionId) ? 'needs_input' : liveTurn.isEnded() ? 'completed' : 'running',
            controlDetail(_pendingControl.current(sessionId)),
            options.runtime,
          );
        }
      });
    },
    onControlRequest: (req) => {
      // Permission state must update the list even when another runtime source
      // owns ordinary running/completed status updates.
      enqueue(() => queuePermissionRequest(sessionId, req, {
        runtime: options.runtime || 'claude',
        nativeSessionId: options.nativeSessionId || sessionId,
        liveTurn,
      }));
    },
    onControlResolved: (requestId) => {
      enqueue(() => dismissPendingControl(sessionId, requestId));
    },
    onError: (sid, err) => {
      console.log(`[ws] live interaction error for ${sessionId.slice(0, 8)}: code=${err.code} ${err.detail || ''}`);
      enqueue(() => {
        if ((options.runtime || 'claude') !== 'claude') clearPendingControls(sessionId);
        finishTurn({ error: 'unavailable' });
        if (options.syncStatus !== false) syncInteractionStatus(sessionId, 'completed', '', options.runtime);
      });
      ack(false, err.detail || 'Session unavailable (busy elsewhere). Read-only.');
    },
  };
  callbacks.failTurn = (error = 'unavailable') => enqueue(() => finishTurn({ error }));
  callbacks.rejectInput = (id, detail) => enqueue(() => {
    liveTurn.rejectInput?.(id, detail);
    if (liveTurn.isEnded()) discardTurn();
  });
  callbacks.discardTurn = discardTurn;
  if (execution) _liveExecutions.set(sessionId, callbacks);
  return callbacks;
}

// Codex Goal continuations start without a user prompt; each gets its own live turn.
function goalContinuationCallbacks(identity, cwd = '') {
  return (turnId) => createStreamCallbacks(identity.sessionId, turnId, cwd, () => {}, {
    runtime: 'codex',
    nativeSessionId: identity.nativeSessionId,
    goalContinuation: true,
  });
}

async function handleAdapterSend(adapter, identity, text, turnId, sendOptions = {}) {
  const filePath = adapter.findSessionFile(identity.nativeSessionId);
  if (!synced.has(identity.sessionId) && filePath) {
    try { synced.set(identity.sessionId, countJsonlLines(filePath)); } catch {}
  }

  const liveTurnId = sendOptions.reservedTurnId
    || resolveTurnId(identity.sessionId, turnId);
  let callbacks = null;
  let acked = false;
  const ack = (ok, error, meta = {}) => {
    if (acked) return;
    acked = true;
    wsSend({
      action: 'send_message_result',
      sessionId: identity.sessionId,
      ok,
      error,
      turnId,
      ...meta,
    });
  };
  const conflict = adapter.interaction.heldElsewhere && await writerConflict(identity.nativeSessionId,
    sendOptions.takeover, sendOptions.expectedWriterPid,
    { runtime: identity.runtime, label: adapter.displayName, findWriter: (id) => adapter.interaction.heldElsewhere(id) });
  if (conflict) {
    ack(false, conflict.error, { errorCode: conflict.errorCode, writer: conflict.writer });
    return true;
  }
  try {
    callbacks = createStreamCallbacks(
      identity.sessionId,
      liveTurnId,
      '',
      ack,
      {
        runtime: identity.runtime,
        nativeSessionId: identity.nativeSessionId,
        syncStatus: identity.runtime !== 'claude',
        userInitiated: true,
        ...(identity.runtime === 'claude' ? { userText: text } : {}),
      },
    );
    await adapter.interaction.sendExisting({
      sessionId: identity.sessionId,
      nativeSessionId: identity.nativeSessionId,
      streamId: liveTurnId,
      text,
      cwd: sendOptions.cwd || '',
      callbacks,
      takeover: sendOptions.takeover,
      expectedWriterPid: sendOptions.expectedWriterPid,
    });
    ack(true);
    return true;
  } catch (error) {
    callbacks?.rejectInput(liveTurnId, error.message);
    endTakeover(identity.sessionId);
    const errorCode = {
      CODEX_ACTIVE_WRITER: 'codex_active_writer',
      CODEX_WRITER_CHANGED: 'codex_writer_changed',
      CODEX_WRITER_UNSAFE: 'codex_writer_unsafe',
    }[error.code];
    ack(
      false,
      error.message || 'Session unavailable.',
      errorCode ? { errorCode, writer: error.writer } : {},
    );
    return true;
  }
}

async function handleCodexCommand(adapter, identity, command, turnId, options = {}) {
  const liveTurnId = options.reservedTurnId
    || resolveTurnId(identity.sessionId, turnId);
  let callbacks = null;
  let acked = false;
  const ack = (ok, error, meta = {}) => {
    if (acked) return;
    acked = true;
    wsSend({
      action: 'send_message_result',
      sessionId: identity.sessionId,
      ok,
      error,
      turnId,
      ...meta,
    });
  };
  try {
    callbacks = createStreamCallbacks(
      identity.sessionId,
      liveTurnId,
      options.cwd || '',
      ack,
      {
        runtime: 'codex',
        nativeSessionId: identity.nativeSessionId,
        syncStatus: false,
        userInitiated: true,
        steer: false,
      },
    );
    const result = await adapter.interaction.runCommand({
      sessionId: identity.sessionId,
      nativeSessionId: identity.nativeSessionId,
      streamId: liveTurnId,
      name: command.name,
      args: command.args,
      cwd: options.cwd || '',
      callbacks,
      goalCallbacks: goalContinuationCallbacks(identity, options.cwd || ''),
      takeover: options.takeover,
      expectedWriterPid: options.expectedWriterPid,
    });
    ack(true, null, result?.output != null
      ? {
        commandOutput: result.output,
        commandName: command.name,
        ...(result.action ? { commandAction: result.action } : {}),
      }
      : {
        commandNoEcho: !!result?.streaming,
        commandName: command.name,
        ...(result?.action ? { commandAction: result.action } : {}),
      });
  } catch (error) {
    callbacks?.failTurn('unavailable');
    const errorCode = {
      CODEX_ACTIVE_WRITER: 'codex_active_writer',
      CODEX_WRITER_CHANGED: 'codex_writer_changed',
      CODEX_WRITER_UNSAFE: 'codex_writer_unsafe',
    }[error.code];
    ack(
      false,
      error.message || 'Codex command failed.',
      errorCode ? { errorCode, writer: error.writer } : {},
    );
  }
}

async function handleClaudeCommand(
  identity,
  command,
  turnId,
  projectHash,
  reservedTurnId = null,
) {
  let cwd = projectHash ? projectHashToPath(projectHash) : null;
  if (!cwd) cwd = cwdForSession(identity.nativeSessionId);
  if (!cwd) {
    wsSend({
      action: 'send_message_result',
      sessionId: identity.sessionId,
      ok: false,
      error: 'Session unavailable.',
      turnId,
    });
    return;
  }

  try { if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true }); } catch {}
  const liveTurnId = reservedTurnId
    || resolveTurnId(identity.sessionId, turnId);
  const settingsTab = !command.args && {
    usage: 'usage',
    cost: 'usage',
    stats: 'stats',
    status: 'status',
    config: 'config',
    settings: 'config',
  }[command.name];
  if (settingsTab) {
    try {
      const panel = await buildClaudeUsagePanel({
        pool: _pool,
        sessionId: identity.nativeSessionId,
        cwd,
        filePath: _claudeRuntime.findSessionFile(identity.nativeSessionId),
        initialTab: settingsTab,
      });
      const commandOutput = panel.rawText;
      delete panel.rawText;
      wsSend({
        action: 'send_message_result',
        sessionId: identity.sessionId,
        ok: true,
        error: null,
        turnId,
        commandOutput,
        commandPanel: panel,
        commandName: command.name,
      });
    } catch (error) {
      wsSend({
        action: 'send_message_result',
        sessionId: identity.sessionId,
        ok: false,
        error: error.message || 'Claude Code settings are unavailable.',
        turnId,
      });
    }
    return;
  }

  let acked = false;
  const ack = (ok, error, meta = {}) => {
    if (acked) return;
    acked = true;
    wsSend({
      action: 'send_message_result',
      sessionId: identity.sessionId,
      ok,
      error,
      turnId,
      ...meta,
    });
  };
  let callbacks = null;
  try {
    if (_pool.isBusy(identity.nativeSessionId)) {
      ack(false, `/${command.name} is unavailable while a task is running.`);
      return;
    }
    callbacks = createStreamCallbacks(
      identity.sessionId,
      liveTurnId,
      cwd,
      ack,
      { userInitiated: true, steer: false, userText: command.text },
    );
    // CC emits the same synthetic assistant row and result text for synchronous
    // local commands. commandOutput below is the single rendered source.
    callbacks.onMessage = () => {};
    const onResult = callbacks.onResult;
    callbacks.onResult = (sid, result) => {
      const output = typeof result.result === 'string' ? result.result : '';
      if (result.is_error) ack(false, output || result.subtype || 'Claude command failed.');
      else {
        ack(true, null, {
          commandOutput: output,
          commandName: command.name,
        });
      }
      onResult(sid, result);
    };

    if (!_pool.owns(identity.nativeSessionId)
      && getDaemonRunningSessionIds().has(identity.nativeSessionId)) {
      _pool.stopDaemon(identity.nativeSessionId);
    }
    syncPoolStatus(identity.nativeSessionId, 'running');
    let res = await _pool.send(identity.nativeSessionId, command.text, {
      cwd,
      resumeId: identity.nativeSessionId,
      streamId: liveTurnId,
      ...callbacks,
    });
    if (res?.bgLocked) {
      _pool.stopDaemon(identity.nativeSessionId);
      res = await _pool.send(identity.nativeSessionId, command.text, {
        cwd,
        resumeId: identity.nativeSessionId,
        streamId: liveTurnId,
        ...callbacks,
      });
    }
  } catch (error) {
    callbacks?.failTurn('unavailable');
    ack(false, error.message || 'Claude command failed.');
  }
}

async function newAdapterSession(
  adapter,
  cwd,
  text,
  requestId,
  turnId,
) {
  const liveTurnId = turnId || newTurnId();
  let callbacks = null;
  let acked = false;
  const ack = (ok, sessionId, error) => {
    if (acked) return;
    acked = true;
    wsSend({
      action: 'send_message_result',
      sessionId,
      ok,
      error,
      requestId,
      turnId: liveTurnId,
    });
  };
  try {
    await adapter.interaction.create({
      cwd,
      text,
      streamId: liveTurnId,
      onCreated: async ({ nativeSessionId, sessionId }) => {
        void syncInteractionStatus(sessionId, 'running', '', adapter.runtime, {
          waitForFile: true,
          registerNew: true,
          ...(adapter.runtime === 'codex' ? { fileReady: (filePath) => !!inspectCodexSession(nativeSessionId, { filePath }) } : {}),
        });
        if (runtimeDescriptor(adapter.runtime)) sessionIndex.notePrompt(nativeSessionId, text);
        callbacks = createStreamCallbacks(sessionId, liveTurnId, cwd, (_ok, error) => {
          ack(false, sessionId, error);
        }, {
          runtime: adapter.runtime,
          nativeSessionId,
          syncStatus: false,
          userInitiated: true,
        });
        ack(true, sessionId);
        return callbacks;
      },
    });
  } catch (error) {
    callbacks?.failTurn('unavailable');
    ack(false, '', error.message || 'Session creation failed.');
  }
}

// Send to an existing session (regular OR agent), taking a daemon-held agent over into the pool via stopDaemon + --resume. See docs/headless-streaming.md §takeover.
async function handleHeadlessSend(
  sessionId,
  text,
  turnId,
  projectHash,
  reservedTurnId = null,
  { takeover = false, expectedWriterPid = null } = {},
) {
  // cwd from projectHash (works even if jsonl was deleted); fall back to jsonl reverse-lookup.
  let cwd = projectHash ? projectHashToPath(projectHash) : null;
  if (!cwd) cwd = cwdForSession(sessionId);
  if (!cwd) return false;
  // Deleted/never-existed project dir → recreate so headless can spawn there (cheap: microseconds).
  try { if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true }); } catch {}

  // Baseline synced to the current jsonl length before this turn appends — else a session the watcher has not seen yet gets its whole history re-pushed (flicker). The App reads history itself.
  if (!synced.has(sessionId)) {
    const fp = _claudeRuntime.findSessionFile(sessionId);
    if (fp) { try { synced.set(sessionId, countJsonlLines(fp)); } catch {} }
  }

  const liveTurnId = reservedTurnId || resolveTurnId(sessionId, turnId);
  let acked = false;
  const ack = (ok, error, meta = {}) => {
    if (acked) return;
    acked = true;
    wsSend({ action: 'send_message_result', sessionId, ok, error, turnId, ...meta });
  };

  // Not in pool but daemon holds it → release so --resume can take over.
  if (!_pool.owns(sessionId) && getDaemonRunningSessionIds().has(sessionId)) {
    _pool.stopDaemon(sessionId);
  } else {
    const conflict = await writerConflict(sessionId, takeover, expectedWriterPid);
    if (conflict) {
      ack(false, conflict.error, { errorCode: conflict.errorCode, writer: conflict.writer });
      return true;
    }
  }

  syncPoolStatus(sessionId, 'running');

  let cb = null;
  try {
    cb = createStreamCallbacks(
      sessionId,
      liveTurnId,
      cwd,
      ack,
      { userInitiated: true, userText: text },
    );
    let res = await _pool.send(sessionId, text, {
      cwd,
      resumeId: sessionId,
      streamId: liveTurnId,
      ...cb,
    });
    // Roster read was stale (raced a still-active daemon agent) → stop + retry once.
    if (res && res.bgLocked) {
      _pool.stopDaemon(sessionId);
      res = await _pool.send(sessionId, text, {
        cwd,
        resumeId: sessionId,
        streamId: liveTurnId,
        ...cb,
      });
    }
  } catch (error) {
    cb?.failTurn('unavailable');
    endTakeover(sessionId);
    ack(false, error.message || 'Session unavailable.');
    return true;
  }

  ack(true);
  return true;
}

// A session another client holds must be let go first; only the pid the user confirmed is killed.
export async function writerConflict(sessionId, takeover, expectedWriterPid, {
  runtime = 'claude',
  label = 'Claude Code',
  findWriter = (sid) => claudeSessionWriter(sid, { ownPids: _pool.ownPids() }),
  kill = process.kill,
  timeoutMs = 10_000,
} = {}) {
  const writer = await findWriter(sessionId);
  if (!writer) return null;
  const held = (current) => ({ errorCode: `${runtime}_active_writer`, error: `The ${label} session is open elsewhere`, writer: current });
  if (!takeover) return held(writer);
  if (writer.pid !== Number(expectedWriterPid)) {
    return { errorCode: `${runtime}_writer_changed`, error: `The ${label} writer changed before takeover`, writer };
  }
  const alive = () => { try { kill(writer.pid, 0); return true; } catch { return false; } };
  noteTakeover(storageSessionId(runtime, sessionId));
  try { kill(writer.pid, 'SIGTERM'); } catch {}
  for (const end = Date.now() + timeoutMs; alive() && Date.now() < end;) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const next = alive() ? writer : await findWriter(sessionId);
  if (next) endTakeover(storageSessionId(runtime, sessionId));
  if (alive()) return { errorCode: `${runtime}_writer_unsafe`, error: `The ${label} terminal did not exit`, writer };
  return next ? held(next) : null;
}

// New regular session: mint the session id upfront and stream the first turn.
async function newRegularSession(
  cwd,
  text,
  requestId,
  turnId,
) {
  const sessionId = crypto.randomUUID();
  _sentPrompts.set(sessionId, text);
  sessionIndex.notePrompt(sessionId, text);
  const liveTurnId = resolveTurnId(sessionId, turnId);
  // The result subscribes the sender to the new Session before its first frame is produced.
  wsSend({
    action: 'send_message_result',
    sessionId,
    ok: true,
    requestId,
    turnId: liveTurnId,
  });
  const cb = createStreamCallbacks(
    sessionId,
    liveTurnId,
    cwd,
    () => {},
    { userInitiated: true, userText: text },
  );
  try {
    await _pool.send(sessionId, text, {
      cwd,
      createId: sessionId,
      streamId: liveTurnId,
      ...cb,
    });
  } catch (error) {
    cb.failTurn('unavailable');
    throw error;
  }
}

// New agent: launch detached `claude --bg` (can't pool — conflicts with -p), parse its `backgrounded · <shortid>`, resolve full sid via `claude agents --json`. First task shows via agent poll + watcher; next message takes it over (handleHeadlessSend).
async function newAgentSession(cwd, text) {
  let bin;
  try {
    bin = requireClaudeBin();
  } catch (error) {
    return { ok: false, error: error.message };
  }
  let out = '';
  try {
    out = await new Promise((resolve, reject) => {
      const p = spawn(bin, ['--bg', text], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let buf = '';
      p.stdout.on('data', (d) => { buf += d.toString(); });
      p.stderr.on('data', (d) => { buf += d.toString(); });
      p.on('close', () => resolve(buf));
      p.on('error', reject);
    });
  } catch (e) {
    return { ok: false, error: `Failed to launch agent: ${e.message}` };
  }

  const m = out.match(/backgrounded[^\n]*?\b([0-9a-f]{8})\b/i);
  if (!m) return { ok: false, error: 'Agent launch did not report a session id.' };
  const shortId = m[1];

  // Resolve full sessionId (daemon writes it lazily → retry a few times).
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 500));
    for (const sid of getAgentsJson(true).keys()) {
      if (sid.startsWith(shortId)) return { ok: true, sessionId: sid };
    }
  }
  // Fallback: scan the project dir for a fresh jsonl matching the short id.
  const dir = path.join(os.homedir(), '.claude', 'projects');
  try {
    for (const proj of fs.readdirSync(dir)) {
      const f = fs.readdirSync(path.join(dir, proj)).find((n) => n.startsWith(shortId) && n.endsWith('.jsonl'));
      if (f) return { ok: true, sessionId: f.replace('.jsonl', '') };
    }
  } catch {}
  return { ok: false, error: 'Agent launched but its session id could not be resolved yet.' };
}

// Create a new project directory and return its projectHash. No session is spawned:
// the App enters the new-session input, and the first message creates the session.
function createProject(rawPath, asAgent) {
  if (!rawPath) return { ok: false, error: 'no path provided', projectPath: rawPath };
  try {
    const { projectHash, projectName } = createProjectDirectory(rawPath);
    return { ok: true, projectHash, projectName, projectPath: rawPath, asAgent: !!asAgent };
  } catch (err) {
    return { ok: false, error: err.message, projectPath: rawPath };
  }
}

// Delete original runtime history when requested by the app.
export async function handleDeleteFiles(msg, {
  context = { watermarks: synced, pool: _pool },
  adapters = runtimeAdapters,
  send = wsSend,
} = {}) {
  let skippedReadOnly = 0;
  let deletedSessions = 0;
  let deletedProjects = 0;
  const errors = [];
  context.codexDeleteClients = new Map();
  const progress = msg.progress ? setInterval(() => {
    try { send({ action: 'delete_files_result', requestId: msg.requestId, pending: true }); } catch {}
  }, 2000) : null;
  async function remove(adapter, method, id) {
    try {
      if (!adapter) throw new Error('Unknown session runtime');
      if (!adapter.features.deleteHistory) {
        skippedReadOnly++;
        return false;
      }
      if (!await adapter[method](id, context)) throw new Error('History files could not be deleted');
      return true;
    } catch (error) {
      errors.push(`${adapter?.runtime || 'unknown'}: ${error.message}`);
      return false;
    }
  }
  try {
    for (const sid of msg.sessionIds || []) {
      const identity = parseStorageSessionId(sid);
      const adapter = adapters.find((item) => item.runtime === identity.runtime);
      // Some harnesses delete a Session another client is using; the Bridge refuses first.
      const interaction = adapter?.interaction;
      if (interaction?.heldElsewhere && (interaction.isBusy(identity.nativeSessionId)
        || await interaction.heldElsewhere(identity.nativeSessionId))) {
        errors.push(`${adapter.runtime}: the Session is in use`);
        continue;
      }
      if (await remove(adapter, 'deleteSessionHistory', identity.nativeSessionId)) {
        deletedSessions++;
        _grants.forget(identity.sessionId);
      }
    }
    for (const ph of msg.projectHashes || []) {
      let ok = true;
      for (const adapter of adapters) {
        if (!await remove(adapter, 'deleteProjectHistory', ph)) ok = false;
      }
      if (ok) deletedProjects++;
    }
  } catch (error) {
    errors.push(error.message);
  } finally {
    if (progress) clearInterval(progress);
    await Promise.allSettled([...context.codexDeleteClients.values()].map(({ client }) =>
      Promise.resolve().then(() => client.stop()),
    ));
  }
  const result = {
    action: 'delete_files_result', requestId: msg.requestId,
    ok: errors.length === 0 && skippedReadOnly === 0,
    skippedReadOnly, deletedSessions, deletedProjects, errors,
    ...(errors.length ? { error: errors.join('; ') } : {}),
  };
  console.log(`[ws] deleted files: ${result.deletedSessions} sessions, ${result.deletedProjects} projects, ${result.errors.length} errors`);
  if (result.deletedSessions || result.deletedProjects) sessionIndex.rescan();
  send(result);
  return result;
}

// The catalog in the reply (no S3 copy); `knownRevision` gets `notModified` when it is current.
async function listCommands({ projectHash, knownRevision = '', runtime = 'claude' }) {
  let result;
  try {
    const dir = typeof projectHash === 'string' && projectHash ? projectHashToPath(projectHash) : null;
    const cwd = path.resolve(dir || process.cwd());
    result = await commandCatalog(runtime, cwd, dir || cwd, { forceRefresh: true });
  } catch (err) {
    console.error(`[ws] list_commands failed: ${err.message}`);
    result = null;
  }
  return commandCatalogPayload(result, knownRevision);
}

async function listCommandOptions({ projectHash, runtime = 'claude', sessionId = '', commandName = '' }) {
  let options = [];
  let error = '';
  try {
    const dir = typeof projectHash === 'string' && projectHash ? projectHashToPath(projectHash) : null;
    if (runtime === 'codex') {
      const identity = sessionId ? parseStorageSessionId(sessionId, 'codex') : null;
      const context = await getRuntimeAdapter('codex').interaction.listCommandContext({
        cwd: path.resolve(dir || process.cwd()),
        nativeSessionId: identity?.nativeSessionId || '',
        forceReload: false,
      });
      options = context.commandOptions?.[commandName] || [];
    }
  } catch (err) {
    error = err.message;
    console.error(`[ws] list_command_options failed: ${error}`);
  }
  return { commandName, options, error };
}

async function downloadBridgeImage(key) {
  try {
    const tmpDir = path.join(os.homedir(), '.baton-bridge', 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const localPath = path.join(tmpDir, key);
    fs.writeFileSync(localPath, await transfer.bytes(key));
    return localPath;
  } catch { return null; }
}

// App answered permission_request. Claude plans use native approval; questions
// and plan feedback use deny+answerText. Codex preserves its native decision.
function handlePermissionReply(msg) {
  const {
    sessionId, requestId, decision, answerText, approvalResponse, answers, scope,
  } = msg;
  const pending = _pendingControl.current(sessionId);
  if (!pending || (requestId && pending.requestId !== requestId)) return;

  let replied = false;
  if (pending.runtime !== 'claude') {
    const adapter = getRuntimeAdapter(pending.runtime);
    replied = !!adapter.interaction?.replyControl?.(
      pending.nativeSessionId,
      pending.requestId,
      { decision, answerText, approvalResponse, answers, scope },
    );
  } else if (pending.hookReply) {
    if (pending.requiresInteraction && decision === 'answer' && answerText) {
      replied = pending.hookReply({ action: 'answer', answerText });
    } else if (decision === 'allow') {
      replied = pending.hookReply({ action: 'allow' });
    } else {
      replied = pending.hookReply({
        action: 'deny',
        reason: pending.requiresInteraction
          ? 'The user did not answer through Baton.'
          : 'The user denied this tool call through Baton.',
      });
    }
  } else if (decision === 'allow'
    && (pending.toolName === 'ExitPlanMode' || pending.toolName === 'exit_plan_mode')) {
    // Execute ExitPlanMode so Claude restores the pre-plan permission mode.
    replied = _pool.replyControl(sessionId, pending.requestId, { behavior: 'allow', updatedInput: pending.input });
  } else if (pending.requiresInteraction) {
    // ask/plan feedback → deny+message; cancel → deny+interrupt.
    if (decision === 'answer' && answerText) {
      replied = _pool.replyControl(sessionId, pending.requestId, { behavior: 'deny', message: answerText });
    } else {
      replied = _pool.replyControl(sessionId, pending.requestId, { behavior: 'deny', message: 'The user did not answer.', interrupt: true });
    }
  } else {
    // Ordinary Claude tool: allow (input unchanged, for this Session too) or deny.
    const session = decision === 'allow' && scope === 'session' && pending.sessionScope;
    if (session) _grants.add(sessionId, session.grants);
    replied = session
      ? _pool.replyControl(sessionId, pending.requestId, { behavior: 'allow', updatedInput: pending.input,
        updatedPermissions: [{ type: 'addRules', rules: session.rules, behavior: 'allow', destination: 'session' }] })
      : decision === 'allow'
      ? _pool.replyControl(sessionId, pending.requestId, { behavior: 'allow', updatedInput: pending.input })
      : _pool.replyControl(sessionId, pending.requestId, { behavior: 'deny', message: 'User denied this tool call.' });
  }
  if (!replied) return;

  const advanced = _pendingControl.resolve(sessionId, pending.requestId);
  if (!advanced) return;
  if (advanced.next) {
    sendPermissionRequest(sessionId, advanced.next);
    if (advanced.next.syncStatus) {
      syncInteractionStatus(
        sessionId,
        'needs_input',
        controlDetail(advanced.next),
        advanced.next.runtime,
      );
    }
  } else {
    const activity = resolvedControlActivity(pending, { approvalResponse });
    sendPermissionResolved(sessionId, pending, activity);
    if (pending.syncStatus) {
      syncInteractionStatus(sessionId, 'running', '', pending.runtime);
    }
  }
}
