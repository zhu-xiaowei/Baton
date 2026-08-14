import { CodexAppServerClient } from './codex-app-server.mjs';
import {
  codexCompletedLiveMessages,
  codexItemLiveKey,
  codexPreviewBlocks,
  codexTurnErrorLiveKey,
  codexTurnErrorLiveMessage,
  codexTurnUserLiveKey,
  codexUserLiveKey,
} from './codex-live.mjs';
import {
  codexWriterController,
  isCodexActiveWriterError,
} from './codex-writer.mjs';
import { defineInteractionAdapter } from './interaction-adapter.mjs';
import { registerLiveMessageStream } from './live-message-registry.mjs';
import { storageSessionId } from './session-identity.mjs';
import { StreamFramer } from './stream-framer.mjs';

function turnStatusError(turn) {
  const status = turn?.status || 'completed';
  return ['failed', 'interrupted'].includes(status) ? status : undefined;
}

function commandApprovalDecisions(params) {
  if (Array.isArray(params.availableDecisions) && params.availableDecisions.length) {
    return params.availableDecisions;
  }

  const decisions = ['accept'];
  if (params.networkApprovalContext) {
    decisions.push('acceptForSession');
    const amendment = (params.proposedNetworkPolicyAmendments || [])
      .find((candidate) => candidate?.action === 'allow');
    if (amendment) {
      decisions.push({
        applyNetworkPolicyAmendment: {
          network_policy_amendment: amendment,
        },
      });
    }
  } else if (!params.additionalPermissions
    && Array.isArray(params.proposedExecpolicyAmendment)
    && params.proposedExecpolicyAmendment.length) {
    decisions.push({
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: params.proposedExecpolicyAmendment,
      },
    });
  }
  decisions.push('cancel');
  return decisions;
}

function approvalDecisionKey(decision) {
  try {
    return JSON.stringify(decision, (_key, value) => (
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(
          Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
        )
        : value
    ));
  } catch {
    return '';
  }
}

function normalizeApprovalDecision(pending, decision) {
  const legacy = decision === 'allow'
    ? 'accept'
    : (decision === 'deny' ? 'decline' : decision);
  const allowed = pending.approvalDecisions || [];
  const key = approvalDecisionKey(legacy);
  if (key && allowed.some((candidate) => approvalDecisionKey(candidate) === key)) {
    return legacy;
  }
  if (allowed.includes('cancel')) return 'cancel';
  if (allowed.includes('decline')) return 'decline';
  return 'cancel';
}

function cloneJson(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function grantedPermissions(permissions) {
  const granted = {};
  if (permissions?.network != null) {
    granted.network = cloneJson(permissions.network, {});
  }
  if (permissions?.fileSystem != null) {
    granted.fileSystem = cloneJson(permissions.fileSystem, {});
  }
  return granted;
}

function permissionApprovalResponse(pending, response) {
  const action = response?.action;
  const grants = [
    'grantForTurn',
    'grantForTurnWithStrictAutoReview',
    'grantForSession',
  ];
  if (!grants.includes(action)) return { permissions: {}, scope: 'turn' };
  return {
    permissions: grantedPermissions(pending.params.permissions),
    scope: action === 'grantForSession' ? 'session' : 'turn',
    ...(action === 'grantForTurnWithStrictAutoReview'
      ? { strictAutoReview: true }
      : {}),
  };
}

function mcpMeta(params) {
  return params?._meta ?? params?.meta ?? null;
}

function mcpPersistModes(meta) {
  const value = meta && typeof meta === 'object' ? meta.persist : null;
  const values = Array.isArray(value) ? value : [value];
  return values.filter((mode) => mode === 'session' || mode === 'always');
}

function isMcpToolApproval(meta) {
  return meta?.codex_approval_kind === 'mcp_tool_call';
}

function mcpApprovalDisplayParams(meta) {
  if (!meta || typeof meta !== 'object') return [];
  if (Array.isArray(meta.tool_params_display)) {
    const display = meta.tool_params_display
      .filter((entry) => (
        entry && typeof entry === 'object' && typeof entry.name === 'string'
      ))
      .slice(0, 3)
      .map((entry) => ({
        name: entry.name,
        displayName: typeof entry.display_name === 'string'
          ? entry.display_name
          : entry.name,
        value: cloneJson(entry.value),
      }));
    if (display.length) return display;
  }
  if (meta.tool_params && typeof meta.tool_params === 'object'
    && !Array.isArray(meta.tool_params)) {
    return Object.entries(meta.tool_params)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 3)
      .map(([name, value]) => ({
        name,
        displayName: name,
        value: cloneJson(value),
      }));
  }
  return [];
}

function mcpFormFields(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)
    || schema.type !== 'object' || !schema.properties
    || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
    return null;
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fields = [];
  for (const [id, property] of Object.entries(schema.properties)) {
    if (!property || typeof property !== 'object' || Array.isArray(property)) return null;
    const label = property.title || id;
    const prompt = property.description || label;
    if (property.type === 'boolean') {
      fields.push({
        id,
        label,
        prompt,
        required: required.has(id),
        input: {
          type: 'select',
          options: [
            { label: 'True', value: true },
            { label: 'False', value: false },
          ],
          defaultIndex: typeof property.default === 'boolean'
            ? (property.default ? 0 : 1)
            : null,
        },
      });
      continue;
    }

    const legacyEnum = property.type === 'string' && Array.isArray(property.enum)
      ? property.enum
      : null;
    const oneOf = property.type === 'string' && Array.isArray(property.oneOf)
      ? property.oneOf
      : null;
    if (legacyEnum && legacyEnum.every((value) => typeof value === 'string')) {
      const names = Array.isArray(property.enumNames) ? property.enumNames : [];
      const defaultIndex = legacyEnum.indexOf(property.default);
      fields.push({
        id,
        label,
        prompt,
        required: required.has(id),
        input: {
          type: 'select',
          options: legacyEnum.map((value, index) => ({
            label: typeof names[index] === 'string' ? names[index] : value,
            value,
          })),
          defaultIndex: defaultIndex >= 0 ? defaultIndex : null,
        },
      });
      continue;
    }
    if (oneOf && oneOf.length && oneOf.every((entry) => (
      entry && typeof entry.const === 'string' && typeof entry.title === 'string'
    ))) {
      const defaultIndex = oneOf.findIndex((entry) => entry.const === property.default);
      fields.push({
        id,
        label,
        prompt,
        required: required.has(id),
        input: {
          type: 'select',
          options: oneOf.map((entry) => ({
            label: entry.title,
            value: entry.const,
          })),
          defaultIndex: defaultIndex >= 0 ? defaultIndex : null,
        },
      });
      continue;
    }
    if (property.type === 'string') {
      fields.push({
        id,
        label,
        prompt,
        required: required.has(id),
        input: { type: 'text' },
      });
      continue;
    }
    return null;
  }
  return fields;
}

function mcpElicitationDetails(params) {
  const meta = mcpMeta(params);
  const schema = params.requestedSchema ?? null;
  const fields = mcpFormFields(schema);
  const emptySchema = schema == null
    || (fields && fields.length === 0);
  let responseMode = 'fallback';
  if (params.mode === 'form' && emptySchema) responseMode = 'approval';
  else if (params.mode === 'form' && fields?.length) responseMode = 'form';
  return {
    serverName: params.serverName || 'MCP server',
    mode: params.mode || 'form',
    message: params.message || '',
    responseMode,
    isToolApproval: isMcpToolApproval(meta),
    persistModes: mcpPersistModes(meta),
    displayParams: mcpApprovalDisplayParams(meta),
    fields: responseMode === 'form' ? fields : [],
  };
}

function validMcpFormContent(schema, value) {
  const fields = mcpFormFields(schema);
  if (!fields?.length || !value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const allowed = new Map(fields.map((field) => [field.id, field]));
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  const content = [];
  for (const field of fields) {
    if (!Object.hasOwn(value, field.id)) {
      if (field.required) return null;
      continue;
    }
    const answer = value[field.id];
    if (field.input.type === 'text') {
      if (typeof answer !== 'string' || (field.required && !answer)) return null;
    } else if (!field.input.options.some((option) => (
      approvalDecisionKey(option.value) === approvalDecisionKey(answer)
    ))) {
      return null;
    }
    content.push([field.id, answer]);
  }
  return Object.fromEntries(content);
}

function mcpElicitationResponse(pending, response) {
  const params = pending.params || {};
  const details = mcpElicitationDetails(params);
  const action = response?.action;
  if (details.responseMode === 'form' && action === 'acceptForm') {
    const content = validMcpFormContent(
      params.requestedSchema,
      response.content,
    );
    if (content) return { action: 'accept', content, _meta: null };
  }
  if (details.responseMode === 'approval') {
    if (action === 'accept') return { action: 'accept', content: null, _meta: null };
    if (action === 'acceptForSession' && details.persistModes.includes('session')) {
      return {
        action: 'accept',
        content: null,
        _meta: { persist: 'session' },
      };
    }
    if (action === 'acceptAlways' && details.persistModes.includes('always')) {
      return {
        action: 'accept',
        content: null,
        _meta: { persist: 'always' },
      };
    }
    if (action === 'decline' && !details.isToolApproval) {
      return { action: 'decline', content: null, _meta: null };
    }
  }
  if (details.responseMode === 'fallback') {
    if (action === 'accept') return { action: 'accept', content: null, _meta: null };
    if (action === 'decline') return { action: 'decline', content: null, _meta: null };
  }
  return { action: 'cancel', content: null, _meta: null };
}

export class CodexInteraction {
  constructor(options = {}) {
    this.runtime = 'codex';
    this.clientFactory = options.clientFactory
      || (options.client
        ? () => options.client
        : (context = {}) => new CodexAppServerClient({
          ...options.clientOptions,
          ...(context.cwd ? { cwd: context.cwd } : {}),
          ...(context.managedOnly ? { managedOnly: true } : {}),
        }));
    this.writerController = options.writerController || codexWriterController;
    this.sessions = new Map();
    this.turns = new Map();
    this.pendingRequests = new Map();
    this.boundClients = new WeakSet();
  }

  #session(nativeSessionId, storageSessionId = '') {
    let session = this.sessions.get(nativeSessionId);
    if (!session) {
      session = {
        nativeSessionId,
        storageSessionId,
        client: null,
        releasePromise: null,
        releasingClient: null,
        subscribedGeneration: 0,
        active: null,
        queue: [],
        sendLock: Promise.resolve(),
      };
      this.sessions.set(nativeSessionId, session);
    } else if (storageSessionId) {
      session.storageSessionId = storageSessionId;
    }
    return session;
  }

  #client(session, options = {}) {
    if (session.client) return session.client;
    const client = this.clientFactory({
      nativeSessionId: session.nativeSessionId,
      storageSessionId: session.storageSessionId,
      managedOnly: !!options.managedOnly,
    });
    if (!client) throw new Error('Codex interaction client factory returned no client');
    session.client = client;
    this.#bindClient(session, client);
    return client;
  }

  #bindClient(session, client) {
    if (!this.boundClients.has(client)) {
      this.boundClients.add(client);
      client.on('notification', (notification) => {
        this.#onNotification(session, client, notification);
      });
      client.on('serverRequest', (request) => {
        this.#onServerRequest(session, client, request);
      });
      client.on('ready', ({ generation }) => {
        if (session.client === client) session.subscribedGeneration = generation - 1;
      });
      client.on('exit', (error) => this.#onExit(session, client, error));
    }
  }

  #activeWriterError(session, error) {
    if (!isCodexActiveWriterError(error)) return error;
    const writer = this.writerController.describe(session.nativeSessionId);
    error.code = 'CODEX_ACTIVE_WRITER';
    error.writer = writer;
    return error;
  }

  async #resume(session, options = {}) {
    if (session.releasePromise) await session.releasePromise;
    const client = this.#client(session, {
      managedOnly: options.managedOnly,
    });
    await client.start();
    if (session.subscribedGeneration === client.generation) return;
    const pendingTurn = options.pendingTurn || null;
    const observedTurn = options.observedTurn || null;
    let adopted = (pendingTurn || observedTurn)
      ? this.#prepareTurn(session, {
        streamId: `codex-resumed-${session.nativeSessionId}-${client.generation}`,
        text: '',
        callbacks: (pendingTurn || observedTurn).callbacks,
        external: true,
      })
      : null;
    if (adopted) {
      session.active = adopted;
      if (pendingTurn) session.queue.push(pendingTurn);
    }
    const clearAdoption = () => {
      if (!adopted) return;
      const current = adopted;
      adopted = null;
      if (pendingTurn) {
        const queuedIndex = session.queue.indexOf(pendingTurn);
        if (queuedIndex !== -1) session.queue.splice(queuedIndex, 1);
      }
      if (session.active === current) session.active = null;
      current.framer.cancel();
    };
    const resumeThread = () => client.request('thread/resume', {
      threadId: session.nativeSessionId,
      excludeTurns: true,
    });
    let result;
    try {
      result = await resumeThread();
    } catch (cause) {
      clearAdoption();
      const error = this.#activeWriterError(session, cause);
      if (error.code !== 'CODEX_ACTIVE_WRITER') throw error;
      const writer = error.writer || {};
      const automaticTakeover = options.allowTakeover !== false
        && !options.takeover
        && writer.canTerminate
        && writer.pid
        && writer.status === 'completed';
      if ((options.allowTakeover === false || !options.takeover)
        && !automaticTakeover) throw error;
      await this.writerController.terminate(
        session.nativeSessionId,
        automaticTakeover ? writer.pid : Number(options.expectedWriterPid),
        automaticTakeover ? { requireIdle: true } : {},
      );
      const deadline = Date.now() + 3000;
      while (true) {
        try {
          result = await resumeThread();
          break;
        } catch (retryCause) {
          if (!isCodexActiveWriterError(retryCause) || Date.now() >= deadline) {
            throw this.#activeWriterError(session, retryCause);
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    }
    if (result?.thread?.id !== session.nativeSessionId) {
      clearAdoption();
      throw new Error('Codex resumed an unexpected thread');
    }
    session.subscribedGeneration = client.generation;
    if (!adopted) return { active: false };
    if (session.active !== adopted) {
      return { active: true };
    }
    if (result?.thread?.status?.type === 'active') {
      return { active: true };
    }
    clearAdoption();
    return { active: false };
  }

  async #release(session) {
    if (session.active || session.queue.length) return;
    if (session.releasePromise) return session.releasePromise;
    const client = session.client;
    if (!client) return;

    session.subscribedGeneration = 0;
    session.releasingClient = client;
    const release = Promise.resolve(client.stop())
      .catch(() => {})
      .finally(() => {
        if (session.client === client) session.client = null;
        if (session.releasingClient === client) session.releasingClient = null;
        if (session.releasePromise === release) session.releasePromise = null;
      });
    session.releasePromise = release;
    return release;
  }

  async sendExisting(options) {
    const session = this.#session(options.nativeSessionId, options.sessionId);
    const turn = {
      streamId: options.streamId,
      text: options.text,
      callbacks: options.callbacks || {},
    };
    const operation = session.sendLock.then(async () => {
      try {
        const resumed = await this.#resume(session, {
          ...options,
          pendingTurn: turn,
        });
        if (resumed?.active) return { queued: true };
      } catch (error) {
        await this.#release(session);
        throw error;
      }
      if (session.active) {
        session.queue.push(turn);
        return { queued: true };
      }
      await this.#startTurn(session, turn);
      return { queued: false };
    });
    session.sendLock = operation.catch(() => {});
    return operation;
  }

  async observeExisting(options) {
    const session = this.#session(options.nativeSessionId, options.sessionId);
    const operation = session.sendLock.then(async () => {
      if (session.active) return { active: true };
      try {
        const client = this.#client(session, { managedOnly: true });
        await client.start();
        const loaded = await client.request('thread/loaded/list');
        if (!(loaded?.data || []).includes(session.nativeSessionId)) {
          await this.#release(session);
          return { active: false, loaded: false };
        }
        const result = await this.#resume(session, {
          observedTurn: {
            callbacks: options.callbacks || {},
          },
          managedOnly: true,
          allowTakeover: false,
        });
        if (!result?.active) await this.#release(session);
        return { active: !!result?.active, loaded: true };
      } catch (error) {
        await this.#release(session);
        return { active: false, loaded: false, error };
      }
    });
    session.sendLock = operation.catch(() => {});
    return operation;
  }

  async create(options) {
    const client = this.clientFactory({ cwd: options.cwd });
    if (!client) throw new Error('Codex interaction client factory returned no client');
    let session = null;
    try {
      await client.start();
      const result = await client.request('thread/start', { cwd: options.cwd });
      const nativeSessionId = result?.thread?.id;
      if (!nativeSessionId) throw new Error('Codex did not return a thread id');

      const sessionId = storageSessionId('codex', nativeSessionId);
      session = this.#session(nativeSessionId, sessionId);
      if (session.client && session.client !== client) {
        throw new Error('Codex created a thread already owned by another client');
      }
      session.client = client;
      session.subscribedGeneration = client.generation;
      this.#bindClient(session, client);

      const callbacks = options.onCreated?.({
        nativeSessionId,
        sessionId,
      }) || options.callbacks || {};
      await this.#startTurn(session, {
        streamId: options.streamId,
        text: options.text,
        callbacks,
      });
      return { nativeSessionId, sessionId };
    } catch (error) {
      if (!session || session.client !== client) {
        await Promise.resolve(client.stop()).catch(() => {});
      } else if (!session.active) {
        await this.#release(session);
      }
      throw error;
    }
  }

  async #startTurn(session, turn) {
    session.active = turn;
    this.#prepareTurn(session, turn);

    try {
      const result = await session.client.request('turn/start', {
        threadId: session.nativeSessionId,
        clientUserMessageId: turn.streamId,
        input: [{ type: 'text', text: turn.text }],
      });
      this.#bindTurnId(turn, result?.turn?.id);
    } catch (error) {
      session.active = null;
      turn.framer.cancel();
      this.#failTurn(turn, error);
      this.#drainOrRelease(session);
      throw error;
    }
  }

  #prepareTurn(session, turn) {
    turn.session = session;
    turn.turnId = null;
    turn.userTurnConfirmed = false;
    turn.nextBlockId = 0;
    turn.items = new Map();
    turn.framer = new StreamFramer((frame) => this.#emitFrame(turn, frame));
    if (!turn.external) {
      registerLiveMessageStream(
        'codex',
        codexUserLiveKey(turn.streamId),
        turn.streamId,
      );
    }
    return turn;
  }

  #failTurn(turn, error) {
    if (turn.ended) return;
    turn.ended = true;
    turn.framer?.cancel();
    turn.callbacks.onError?.(
      turn.streamId,
      { code: error.code || -1, detail: error.message },
    );
  }

  #bindTurnId(turn, turnId, replace = false) {
    if (!turnId) return false;
    if (turn.turnId && turn.turnId !== turnId) {
      if (!replace) return false;
      this.turns.delete(this.#turnKey(turn.session.nativeSessionId, turn.turnId));
    }
    turn.turnId = turnId;
    this.turns.set(this.#turnKey(turn.session.nativeSessionId, turnId), turn);
    registerLiveMessageStream(
      'codex',
      codexTurnErrorLiveKey(turnId),
      turn.streamId,
    );
    return true;
  }

  #turnKey(nativeSessionId, turnId) {
    return `${nativeSessionId}:${turnId}`;
  }

  #turn(session, params) {
    if (params?.threadId && params.threadId !== session.nativeSessionId) return null;
    const existing = params?.turnId
      && this.turns.get(this.#turnKey(session.nativeSessionId, params.turnId));
    if (existing) return existing;
    const turn = session.active;
    if (!turn) return null;
    if (turn.turnId && params?.turnId && turn.turnId !== params.turnId) return null;
    this.#bindTurnId(turn, params?.turnId);
    return turn;
  }

  #startItemBlocks(turn, state, item) {
    if (state.blocks.length) return state;
    const previewItem = {
      ...item,
      type: state.type || item.type,
      phase: state.phase || item.phase,
    };
    for (const preview of codexPreviewBlocks(previewItem)) {
      const blockId = turn.nextBlockId++;
      state.blocks.push(blockId);
      turn.framer.start(blockId, preview.kind, preview.name || null);
      if (preview.input) {
        turn.framer.input(blockId, JSON.stringify(preview.input));
        turn.framer.stop(blockId);
      }
    }
    return state;
  }

  #registerItemStream(turn, item) {
    if (!item) return;
    if (item.type === 'userMessage') {
      const userKey = codexUserLiveKey(item.clientId);
      const turnKey = codexTurnUserLiveKey(turn.turnId);
      if (userKey) registerLiveMessageStream('codex', userKey, turn.streamId);
      if (turnKey) registerLiveMessageStream('codex', turnKey, turn.streamId);
    } else if (item.id) {
      registerLiveMessageStream('codex', codexItemLiveKey(item.id), turn.streamId);
    }
  }

  #itemState(turn, item, options = {}) {
    this.#registerItemStream(turn, item);
    let state = turn.items.get(item.id);
    if (state) {
      if (item.type) state.type = item.type;
      if (item.phase) state.phase = item.phase;
      if (options.startBlocks !== false) this.#startItemBlocks(turn, state, item);
      return state;
    }
    state = {
      itemId: item.id,
      type: item.type,
      phase: item.phase || null,
      blocks: [],
      text: '',
      completed: false,
      stopped: false,
    };
    turn.items.set(item.id, state);
    if (options.startBlocks !== false) this.#startItemBlocks(turn, state, item);
    return state;
  }

  #completeItem(turn, item, completedAtMs) {
    if (!item?.id) return;
    this.#registerItemStream(turn, item);
    const state = this.#itemState(turn, item, { startBlocks: false });
    const finalText = item.type === 'agentMessage' || item.type === 'plan'
      ? String(item.text || '')
      : '';

    // turn/completed carries the final item list. Reconcile from it when an
    // intermediate delta notification was missed so the shared CC stream
    // contract never collapses to finalSeq=0 with a full assistant response.
    if (finalText) {
      this.#startItemBlocks(turn, state, item);
      let missing = '';
      if (!state.text) missing = finalText;
      else if (finalText.startsWith(state.text)) missing = finalText.slice(state.text.length);
      if (missing) {
        state.text += missing;
        turn.framer.delta(state.blocks[0], missing);
      }
    }

    if (!state.stopped && state.blocks.length
      && ['agentMessage', 'reasoning', 'plan'].includes(state.type)) {
      turn.framer.stop(state.blocks[0]);
      state.stopped = true;
    }
    if (state.completed) return;
    state.completed = true;
    for (const complete of codexCompletedLiveMessages(
      item,
      completedAtMs,
      state.text,
      { turnId: turn.turnId },
    )) {
      turn.callbacks.onMessage?.(
        turn.streamId,
        complete.message,
        { normalized: true, runtime: 'codex', liveKey: complete.liveKey },
      );
    }
  }

  #onNotification(session, client, { method, params }) {
    if (session.client !== client) return;
    if (method === 'serverRequest/resolved') {
      const requestId = `codex:${session.nativeSessionId}:${params.requestId}`;
      const pending = this.pendingRequests.get(requestId);
      if (pending) {
        this.pendingRequests.delete(requestId);
        pending.turn.callbacks.onControlResolved?.(requestId);
      }
      return;
    }
    const active = session.active;
    if (active && this.#matchesCurrentUserItem(active, method, params)) {
      this.#bindTurnId(active, params.turnId, true);
      active.userTurnConfirmed = true;
    }
    const turn = this.#turn(session, params);
    if (method === 'turn/started') {
      if (turn) {
        this.#bindTurnId(turn, params.turn?.id, !turn.userTurnConfirmed);
      }
      return;
    }
    if (!turn) return;

    if (method === 'error') {
      if (!params.willRetry) turn.error = params.error;
      return;
    }

    if (method === 'item/started') {
      const streamedType = ['agentMessage', 'reasoning', 'plan']
        .includes(params.item?.type);
      this.#itemState(turn, params.item, { startBlocks: !streamedType });
      return;
    }

    if (method === 'item/agentMessage/delta') {
      const state = this.#itemState(turn, {
        id: params.itemId,
        type: 'agentMessage',
      });
      state.text += params.delta || '';
      turn.framer.delta(state.blocks[0], params.delta || '');
      return;
    }

    if (method === 'item/reasoning/textDelta'
      || method === 'item/reasoning/summaryTextDelta') {
      const state = this.#itemState(turn, {
        id: params.itemId,
        type: 'reasoning',
      });
      state.text += params.delta || '';
      turn.framer.delta(state.blocks[0], params.delta || '');
      return;
    }

    if (method === 'item/plan/delta') {
      const state = this.#itemState(turn, {
        id: params.itemId,
        type: 'plan',
      });
      state.text += params.delta || '';
      turn.framer.delta(state.blocks[0], params.delta || '');
      return;
    }

    if (method === 'item/completed') {
      this.#completeItem(turn, params.item, params.completedAtMs);
      return;
    }

    if (method === 'turn/completed') {
      const completedAtMs = Number.isFinite(params.turn?.completedAt)
        ? params.turn.completedAt * 1000
        : undefined;
      for (const item of params.turn?.items || []) {
        if (['userMessage', 'agentMessage', 'reasoning', 'plan'].includes(item?.type)) {
          this.#completeItem(turn, item, completedAtMs);
        }
      }
      const subtype = turnStatusError(params.turn);
      const errorMessage = codexTurnErrorLiveMessage(
        turn.turnId,
        params.turn?.error,
        completedAtMs,
      ) || codexTurnErrorLiveMessage(
        turn.turnId,
        turn.error,
        completedAtMs,
      ) || (subtype === 'failed'
        ? codexTurnErrorLiveMessage(turn.turnId, subtype, completedAtMs)
        : null);
      if (errorMessage) {
        turn.callbacks.onMessage?.(
          turn.streamId,
          errorMessage.message,
          {
            normalized: true,
            runtime: 'codex',
            liveKey: errorMessage.liveKey,
          },
        );
      }
      const finalSeq = turn.framer.finish();
      turn.ended = true;
      turn.callbacks.onResult?.(
        turn.streamId,
        {
          is_error: !!(errorMessage || subtype),
          subtype,
          status: params.turn?.status,
        },
        finalSeq,
      );
      this.turns.delete(this.#turnKey(
        turn.session.nativeSessionId,
        turn.turnId,
      ));
      turn.session.active = null;
      for (const [requestId, pending] of this.pendingRequests) {
        if (pending.turn === turn) this.pendingRequests.delete(requestId);
      }
      this.#drainOrRelease(turn.session);
    }
  }

  #emitFrame(turn, frame) {
    const cb = turn.callbacks;
    if (frame.t === 'start') {
      cb.onBlockStart?.(
        turn.streamId,
        frame.blockId,
        frame.kind,
        frame.name,
        frame.seq,
      );
    } else if (frame.t === 'delta') {
      cb.onDelta?.(turn.streamId, frame.chunk, frame.seq, frame.blockId);
    } else if (frame.t === 'input') {
      cb.onInputDelta?.(turn.streamId, frame.chunk, frame.seq, frame.blockId);
    } else if (frame.t === 'stop') {
      cb.onBlockStop?.(turn.streamId, frame.blockId, frame.seq);
    }
  }

  #matchesCurrentUserItem(turn, method, params) {
    if (method !== 'item/started' && method !== 'item/completed') return false;
    return params?.item?.type === 'userMessage'
      && params.item.clientId === turn.streamId
      && !!params.turnId;
  }

  #drainOrRelease(session) {
    if (session.active) return;
    if (session.queue.length) {
      const next = session.queue.shift();
      this.#startTurn(session, next).catch(() => {});
      return;
    }
    this.#release(session).catch(() => {});
  }

  #onServerRequest(session, client, request) {
    if (session.client !== client) return;
    const turn = this.#turn(session, request.params);
    if (!turn) {
      client.respondError(request.id, -32602, 'No active AgentPeek turn');
      return;
    }
    const params = request.params || {};
    let toolName = 'Tool';
    let input = params;
    let requiresInteraction = false;
    let approvalDecisions = null;
    let approvalType = null;
    if (request.method === 'item/commandExecution/requestApproval') {
      toolName = 'Bash';
      approvalType = 'codex-command';
      approvalDecisions = commandApprovalDecisions(params);
      input = {
        command: params.command || '',
        cwd: params.cwd || '',
        reason: params.reason || '',
        codexCommandActions: params.commandActions || [],
        codexApproval: {
          availableDecisions: approvalDecisions,
          networkApprovalContext: params.networkApprovalContext || null,
          additionalPermissions: params.additionalPermissions || null,
          proposedExecpolicyAmendment: params.proposedExecpolicyAmendment || null,
          proposedNetworkPolicyAmendments: params.proposedNetworkPolicyAmendments || null,
        },
      };
    } else if (request.method === 'item/fileChange/requestApproval') {
      toolName = 'Edit';
      approvalType = 'codex-file-change';
      approvalDecisions = ['accept', 'acceptForSession', 'cancel'];
      input = {
        path: params.grantRoot || '',
        reason: params.reason || '',
        codexApproval: {
          availableDecisions: approvalDecisions,
        },
      };
    } else if (request.method === 'item/permissions/requestApproval') {
      toolName = 'Permissions';
      approvalType = 'codex-permissions';
      input = {
        cwd: params.cwd || '',
        reason: params.reason || '',
        codexPermissions: {
          permissions: cloneJson(params.permissions, {}),
        },
      };
    } else if (request.method === 'mcpServer/elicitation/request') {
      if (params.mode !== 'form'
        || mcpMeta(params)?.codex_approval_kind === 'tool_suggestion') {
        client.respond(request.id, {
          action: 'decline',
          content: null,
          _meta: null,
        });
        return;
      }
      toolName = params.serverName || 'MCP server';
      approvalType = 'codex-mcp-elicitation';
      input = {
        codexMcpElicitation: mcpElicitationDetails(params),
      };
    } else if (request.method === 'item/tool/requestUserInput') {
      toolName = 'AskUserQuestion';
      input = { questions: params.questions || [] };
      requiresInteraction = true;
    } else {
      client.respondError(request.id, -32601, 'Unsupported Codex server request');
      return;
    }
    const requestId = `codex:${session.nativeSessionId}:${request.id}`;
    this.pendingRequests.set(requestId, {
      ...request,
      turn,
      client,
      approvalDecisions,
    });
    turn.callbacks.onControlRequest?.({
      request_id: requestId,
      request: {
        tool_name: toolName,
        input,
        requires_user_interaction: requiresInteraction,
        approval_type: approvalType,
      },
    });
  }

  replyControl(nativeSessionId, requestId, reply) {
    const pending = this.pendingRequests.get(requestId);
    if (!pending || pending.turn.session.nativeSessionId !== nativeSessionId) return false;
    this.pendingRequests.delete(requestId);
    if (pending.method === 'item/tool/requestUserInput') {
      const answer = reply.answerText || '';
      const answers = Object.fromEntries(
        (pending.params.questions || []).map((question) => [
          question.id,
          { answers: answer ? [answer] : [] },
        ]),
      );
      pending.client.respond(pending.id, { answers });
    } else if (pending.method === 'item/permissions/requestApproval') {
      pending.client.respond(
        pending.id,
        permissionApprovalResponse(pending, reply.approvalResponse),
      );
    } else if (pending.method === 'mcpServer/elicitation/request') {
      pending.client.respond(
        pending.id,
        mcpElicitationResponse(pending, reply.approvalResponse),
      );
    } else {
      pending.client.respond(pending.id, {
        decision: normalizeApprovalDecision(pending, reply.decision),
      });
    }
    return true;
  }

  interrupt(nativeSessionId) {
    const turn = this.sessions.get(nativeSessionId)?.active;
    if (!turn?.turnId) return false;
    turn.session.client.request('turn/interrupt', {
      threadId: nativeSessionId,
      turnId: turn.turnId,
    }).catch(() => {});
    return true;
  }

  owns(nativeSessionId) {
    const session = this.sessions.get(nativeSessionId);
    return !!session?.client
      && session.subscribedGeneration === session.client.generation;
  }

  isBusy(nativeSessionId) {
    return !!this.sessions.get(nativeSessionId)?.active;
  }

  async shutdown() {
    const clients = new Set();
    const releases = [];
    for (const session of this.sessions.values()) {
      if (session.client) clients.add(session.client);
      if (session.releasingClient) clients.add(session.releasingClient);
      if (session.releasePromise) releases.push(session.releasePromise);
      session.active = null;
      session.queue = [];
      session.client = null;
      session.releasingClient = null;
      session.subscribedGeneration = 0;
    }
    this.turns.clear();
    this.pendingRequests.clear();
    await Promise.allSettled([
      ...releases,
      ...[...clients].map((client) => client.stop()),
    ]);
  }

  #onExit(session, client, error) {
    if (session.client !== client || session.releasingClient === client) return;
    session.client = null;
    session.subscribedGeneration = 0;
    const turn = session.active;
    if (turn) {
      this.turns.delete(this.#turnKey(session.nativeSessionId, turn.turnId));
      this.#failTurn(turn, error);
    }
    for (const queued of session.queue) {
      queued.callbacks.onError?.(
        queued.streamId,
        { code: -1, detail: error.message },
      );
    }
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.turn.session === session) this.pendingRequests.delete(requestId);
    }
    session.queue = [];
    session.active = null;
  }
}

export const codexInteraction = defineInteractionAdapter(new CodexInteraction());
