import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import test from 'node:test';
import { CodexInteraction } from '../../../bridge/codex-interaction.mjs';
import {
  clearLiveMessageRegistry,
  liveMessageStream,
} from '../../../bridge/live-message-registry.mjs';

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.generation = 0;
    this.started = false;
    this.stopCalls = 0;
    this.requests = [];
    this.responses = [];
    this.turnSequence = 0;
  }

  async start() {
    if (!this.started) {
      this.started = true;
      this.generation++;
      this.emit('ready', { generation: this.generation });
    }
    return this;
  }

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'thread/resume') return { thread: { id: params.threadId } };
    if (method === 'turn/start') {
      this.turnSequence++;
      return { turn: { id: `turn-${this.turnSequence}` } };
    }
    return {};
  }

  async stop() {
    this.stopCalls++;
    this.started = false;
  }

  respond(id, result) {
    this.responses.push({ id, result });
  }

  respondError(id, code, message) {
    this.responses.push({ id, error: { code, message } });
  }
}

function callbacks() {
  const frames = [];
  const messages = [];
  const results = [];
  const controls = [];
  return {
    frames,
    messages,
    results,
    controls,
    value: {
      onBlockStart: (_sid, blockId, kind, name, seq) => {
        frames.push({ t: 'start', blockId, kind, name, seq });
      },
      onDelta: (_sid, chunk, seq, blockId) => {
        frames.push({ t: 'delta', blockId, chunk, seq });
      },
      onInputDelta: (_sid, chunk, seq, blockId) => {
        frames.push({ t: 'input', blockId, chunk, seq });
      },
      onBlockStop: (_sid, blockId, seq) => {
        frames.push({ t: 'stop', blockId, seq });
      },
      onMessage: (_sid, message, meta) => messages.push({ message, meta }),
      onResult: (_sid, result, finalSeq) => results.push({ result, finalSeq }),
      onControlRequest: (request) => controls.push(request),
    },
  };
}

function notify(client, method, params) {
  client.emit('notification', { method, params });
}

test('existing Codex session releases after completion and reuses CC stream frames', async () => {
  clearLiveMessageRegistry();
  const client = new FakeClient();
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();

  await interaction.sendExisting({
    sessionId: 'codex:thread-1',
    nativeSessionId: 'thread-1',
    streamId: 'stream-1',
    text: 'hello',
    callbacks: cb.value,
  });

  assert.deepEqual(client.requests.slice(0, 2), [
    {
      method: 'thread/resume',
      params: { threadId: 'thread-1', excludeTurns: true },
    },
    {
      method: 'turn/start',
      params: {
        threadId: 'thread-1',
        clientUserMessageId: 'stream-1',
        input: [{ type: 'text', text: 'hello' }],
      },
    },
  ]);

  notify(client, 'turn/started', {
    threadId: 'thread-1',
    turn: { id: 'turn-1', status: 'inProgress' },
  });
  notify(client, 'item/started', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: {
      type: 'userMessage',
      id: 'user-1',
      clientId: 'stream-1',
      content: [{ type: 'text', text: 'hello' }],
    },
  });
  assert.equal(liveMessageStream('codex', 'user:stream-1'), 'stream-1');
  assert.equal(liveMessageStream('codex', 'turn:turn-1:user'), 'stream-1');
  notify(client, 'item/completed', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    completedAtMs: Date.now(),
    item: {
      type: 'userMessage',
      id: 'user-1',
      clientId: 'stream-1',
      content: [{ type: 'text', text: 'hello' }],
    },
  });
  notify(client, 'item/started', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: { type: 'agentMessage', id: 'agent-1', text: '' },
  });
  notify(client, 'item/agentMessage/delta', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'agent-1',
    delta: 'hel',
  });
  notify(client, 'item/agentMessage/delta', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'agent-1',
    delta: 'lo',
  });
  notify(client, 'item/completed', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    completedAtMs: Date.now(),
    item: { type: 'agentMessage', id: 'agent-1', text: 'hello' },
  });
  notify(client, 'turn/completed', {
    threadId: 'thread-1',
    turn: { id: 'turn-1', status: 'completed' },
  });

  assert.deepEqual(cb.frames.map((frame) => frame.t), [
    'start',
    'delta',
    'delta',
    'stop',
  ]);
  assert.deepEqual(cb.frames.map((frame) => frame.seq), [0, 1, 2, 3]);
  assert.equal(cb.frames.filter((frame) => frame.t === 'delta')
    .map((frame) => frame.chunk).join(''), 'hello');
  assert.deepEqual(cb.messages.map(({ message }) => message.type), ['user', 'assistant']);
  assert.equal(cb.messages[0].meta.liveKey, 'user:stream-1');
  assert.deepEqual(cb.messages.map(({ message }) => message.nativeId), [
    'codex:user:stream-1',
    'codex:item:agent-1',
  ]);
  assert.equal(cb.messages[1].meta.liveKey, 'item:agent-1');
  assert.equal(cb.messages[1].message.content[0].text, 'hello');
  assert.equal(cb.results[0].finalSeq, 4);
  assert.equal(cb.results[0].result.is_error, false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(client.stopCalls, 1);
  assert.equal(interaction.owns('thread-1'), false);

  const second = callbacks();
  await interaction.sendExisting({
    sessionId: 'codex:thread-1',
    nativeSessionId: 'thread-1',
    streamId: 'stream-2',
    text: 'again',
    callbacks: second.value,
  });
  assert.equal(client.requests.filter((request) => request.method === 'thread/resume').length, 2);
});

test('turn completion reconciles a final agent item when intermediate notifications are missing', async () => {
  const client = new FakeClient();
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();

  await interaction.sendExisting({
    sessionId: 'codex:thread-reconcile',
    nativeSessionId: 'thread-reconcile',
    streamId: 'stream-reconcile',
    text: 'write a long answer',
    callbacks: cb.value,
  });

  notify(client, 'turn/completed', {
    threadId: 'thread-reconcile',
    turn: {
      id: 'turn-1',
      status: 'completed',
      completedAt: 1_786_442_000,
      items: [{
        type: 'agentMessage',
        id: 'agent-reconciled',
        text: 'complete text recovered from the turn',
      }],
    },
  });

  assert.deepEqual(cb.frames.map((frame) => frame.t), ['start', 'delta', 'stop']);
  assert.equal(cb.frames[1].chunk, 'complete text recovered from the turn');
  assert.equal(cb.results[0].finalSeq, 3);
  assert.equal(cb.messages.length, 1);
  assert.equal(cb.messages[0].message.uuid, 'codex_live_agent_agent-reconciled');
  assert.equal(cb.messages[0].message.content[0].text, 'complete text recovered from the turn');
});

test('terminal Codex errors become visible assistant messages with the API detail', async () => {
  clearLiveMessageRegistry();
  const client = new FakeClient();
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();

  await interaction.sendExisting({
    sessionId: 'codex:thread-error',
    nativeSessionId: 'thread-error',
    streamId: 'stream-error',
    text: 'hello',
    callbacks: cb.value,
  });

  notify(client, 'error', {
    threadId: 'thread-error',
    turnId: 'turn-1',
    error: {
      message: JSON.stringify({
        error: {
          code: 'validation_error',
          message: 'Access to OpenAI models is not allowed from this region.',
        },
      }),
    },
    willRetry: false,
  });
  notify(client, 'turn/completed', {
    threadId: 'thread-error',
    turn: { id: 'turn-1', status: 'completed' },
  });

  assert.equal(cb.messages.length, 1);
  assert.equal(cb.messages[0].meta.liveKey, 'turn:turn-1:error');
  assert.equal(cb.messages[0].message.nativeId, 'codex:turn:turn-1:error');
  assert.equal(
    cb.messages[0].message.content[0].text,
    'Error: Access to OpenAI models is not allowed from this region.',
  );
  assert.equal(cb.messages[0].message.stopReason, 'end_turn');
  assert.deepEqual(cb.results[0].result, {
    is_error: true,
    subtype: undefined,
    status: 'completed',
  });
});

test('retryable Codex errors are not shown when the turn later succeeds', async () => {
  const client = new FakeClient();
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();

  await interaction.sendExisting({
    sessionId: 'codex:thread-retry',
    nativeSessionId: 'thread-retry',
    streamId: 'stream-retry',
    text: 'hello',
    callbacks: cb.value,
  });

  notify(client, 'error', {
    threadId: 'thread-retry',
    turnId: 'turn-1',
    error: { message: 'temporary failure' },
    willRetry: true,
  });
  notify(client, 'turn/completed', {
    threadId: 'thread-retry',
    turn: { id: 'turn-1', status: 'completed' },
  });

  assert.equal(cb.messages.length, 0);
  assert.equal(cb.results[0].result.is_error, false);
});

test('delta notifications from a different turn are ignored', async () => {
  const client = new FakeClient();
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();

  await interaction.sendExisting({
    sessionId: 'codex:thread-mismatch',
    nativeSessionId: 'thread-mismatch',
    streamId: 'stream-mismatch',
    text: 'write an answer',
    callbacks: cb.value,
  });

  notify(client, 'item/agentMessage/delta', {
    threadId: 'thread-mismatch',
    turnId: 'turn-other',
    itemId: 'agent-mismatch',
    delta: 'lost',
  });
  notify(client, 'turn/completed', {
    threadId: 'thread-mismatch',
    turn: {
      id: 'turn-1',
      status: 'completed',
      items: [{
        type: 'agentMessage',
        id: 'agent-recovered',
        text: 'recovered',
      }],
    },
  });

  assert.equal(cb.frames.filter((frame) => frame.t === 'delta')
    .map((frame) => frame.chunk).join(''), 'recovered');
  assert.equal(cb.results[0].finalSeq, 3);
});

test('current client user item corrects a stale turn/start response id', async () => {
  const client = new FakeClient();
  const request = client.request.bind(client);
  client.request = async (method, params) => {
    const result = await request(method, params);
    if (method === 'turn/start') return { turn: { id: 'turn-stale' } };
    return result;
  };
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();

  await interaction.sendExisting({
    sessionId: 'codex:thread-rebind',
    nativeSessionId: 'thread-rebind',
    streamId: 'stream-rebind',
    text: 'stream this',
    callbacks: cb.value,
  });

  notify(client, 'item/started', {
    threadId: 'thread-rebind',
    turnId: 'turn-current',
    item: {
      type: 'userMessage',
      id: 'user-current',
      clientId: 'stream-rebind',
      content: [{ type: 'text', text: 'stream this' }],
    },
  });
  notify(client, 'item/agentMessage/delta', {
    threadId: 'thread-rebind',
    turnId: 'turn-current',
    itemId: 'agent-current',
    delta: 'streamed',
  });
  notify(client, 'turn/completed', {
    threadId: 'thread-rebind',
    turn: {
      id: 'turn-current',
      status: 'completed',
      items: [{
        type: 'agentMessage',
        id: 'agent-current',
        text: 'streamed',
      }],
    },
  });

  assert.equal(cb.frames.filter((frame) => frame.t === 'delta')
    .map((frame) => frame.chunk).join(''), 'streamed');
  assert.equal(cb.results[0].finalSeq, 3);
});

test('Codex commentary streams as visible progress text', async () => {
  const client = new FakeClient();
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();

  await interaction.sendExisting({
    sessionId: 'codex:thread-commentary',
    nativeSessionId: 'thread-commentary',
    streamId: 'stream-commentary',
    text: 'write exactly 300 chars',
    callbacks: cb.value,
  });

  notify(client, 'item/started', {
    threadId: 'thread-commentary',
    turnId: 'turn-1',
    item: {
      type: 'agentMessage',
      id: 'commentary-1',
      text: '',
      phase: 'commentary',
    },
  });
  notify(client, 'item/agentMessage/delta', {
    threadId: 'thread-commentary',
    turnId: 'turn-1',
    itemId: 'commentary-1',
    delta: 'checking the draft',
  });
  notify(client, 'item/completed', {
    threadId: 'thread-commentary',
    turnId: 'turn-1',
    completedAtMs: Date.now(),
    item: {
      type: 'agentMessage',
      id: 'commentary-1',
      text: 'checking the draft',
      phase: 'commentary',
    },
  });

  assert.equal(cb.frames[0].kind, 'text');
  assert.equal(cb.frames[1].t, 'delta');
  assert.deepEqual(cb.messages[0].message.content, [{
    type: 'text',
    text: 'checking the draft',
  }]);
});

test('empty Codex reasoning items do not create preview blocks', async () => {
  const client = new FakeClient();
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();

  await interaction.sendExisting({
    sessionId: 'codex:thread-empty-reasoning',
    nativeSessionId: 'thread-empty-reasoning',
    streamId: 'stream-empty-reasoning',
    text: 'summarize this',
    callbacks: cb.value,
  });

  for (const id of ['reasoning-1', 'reasoning-2']) {
    notify(client, 'item/started', {
      threadId: 'thread-empty-reasoning',
      turnId: 'turn-1',
      item: { type: 'reasoning', id },
    });
    notify(client, 'item/completed', {
      threadId: 'thread-empty-reasoning',
      turnId: 'turn-1',
      completedAtMs: Date.now(),
      item: { type: 'reasoning', id, content: [], summary: [] },
    });
  }
  notify(client, 'item/started', {
    threadId: 'thread-empty-reasoning',
    turnId: 'turn-1',
    item: { type: 'agentMessage', id: 'answer-1', text: '' },
  });
  notify(client, 'item/agentMessage/delta', {
    threadId: 'thread-empty-reasoning',
    turnId: 'turn-1',
    itemId: 'answer-1',
    delta: 'summary',
  });
  notify(client, 'item/completed', {
    threadId: 'thread-empty-reasoning',
    turnId: 'turn-1',
    completedAtMs: Date.now(),
    item: { type: 'agentMessage', id: 'answer-1', text: 'summary' },
  });
  notify(client, 'turn/completed', {
    threadId: 'thread-empty-reasoning',
    turn: { id: 'turn-1', status: 'completed' },
  });

  assert.deepEqual(cb.frames.map((frame) => frame.t), ['start', 'delta', 'stop']);
  assert.deepEqual(cb.frames.map((frame) => frame.blockId), [0, 0, 0]);
  assert.equal(cb.results[0].finalSeq, 3);
});

test('Codex command items use the shared tool preview contract', async () => {
  const client = new FakeClient();
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();
  await interaction.sendExisting({
    sessionId: 'codex:thread-2',
    nativeSessionId: 'thread-2',
    streamId: 'stream-tool',
    text: 'run pwd',
    callbacks: cb.value,
  });

  notify(client, 'item/started', {
    threadId: 'thread-2',
    turnId: 'turn-1',
    item: {
      type: 'commandExecution',
      id: 'command-1',
      command: 'pwd',
      cwd: '/tmp',
      commandActions: [{ type: 'listFiles', command: 'pwd', path: '/tmp' }],
      status: 'inProgress',
    },
  });

  assert.deepEqual(cb.frames.map((frame) => frame.t), ['start', 'input', 'stop']);
  assert.equal(cb.frames[0].kind, 'tool_use');
  assert.equal(cb.frames[0].name, 'Bash');
  assert.deepEqual(JSON.parse(cb.frames[1].chunk), {
    command: 'pwd',
    cwd: '/tmp',
    codexCommandActions: [{ type: 'list_files', command: 'pwd', path: '/tmp' }],
  });
});

test('Codex approval requests map to the existing permission callback', async () => {
  const client = new FakeClient();
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();
  await interaction.sendExisting({
    sessionId: 'codex:thread-3',
    nativeSessionId: 'thread-3',
    streamId: 'stream-approval',
    text: 'run command',
    callbacks: cb.value,
  });

  client.emit('serverRequest', {
    id: 42,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thread-3',
      turnId: 'turn-1',
      itemId: 'command-1',
      command: 'rm file',
      cwd: '/tmp',
    },
  });

  assert.equal(cb.controls[0].request.tool_name, 'Bash');
  assert.equal(cb.controls[0].request.input.command, 'rm file');
  const requestId = cb.controls[0].request_id;
  assert.equal(interaction.replyControl('thread-3', requestId, { decision: 'deny' }), true);
  assert.deepEqual(client.responses[0], {
    id: 42,
    result: { decision: 'decline' },
  });
});

test('Codex file and user-input requests reuse the existing permission replies', async () => {
  const client = new FakeClient();
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();
  await interaction.sendExisting({
    sessionId: 'codex:thread-4',
    nativeSessionId: 'thread-4',
    streamId: 'stream-controls',
    text: 'edit and ask',
    callbacks: cb.value,
  });

  client.emit('serverRequest', {
    id: 43,
    method: 'item/fileChange/requestApproval',
    params: {
      threadId: 'thread-4',
      turnId: 'turn-1',
      itemId: 'file-1',
      grantRoot: '/tmp/project',
      reason: 'edit file',
    },
  });
  const fileRequest = cb.controls.at(-1);
  assert.equal(fileRequest.request.tool_name, 'Edit');
  assert.equal(interaction.replyControl(
    'thread-4',
    fileRequest.request_id,
    { decision: 'allow' },
  ), true);

  client.emit('serverRequest', {
    id: 44,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-4',
      turnId: 'turn-1',
      itemId: 'ask-1',
      questions: [{ id: 'choice', question: 'Choose' }],
    },
  });
  const askRequest = cb.controls.at(-1);
  assert.equal(askRequest.request.requires_user_interaction, true);
  assert.equal(interaction.replyControl(
    'thread-4',
    askRequest.request_id,
    { decision: 'answer', answerText: 'A' },
  ), true);

  assert.deepEqual(client.responses, [
    { id: 43, result: { decision: 'accept' } },
    {
      id: 44,
      result: {
        answers: {
          choice: { answers: ['A'] },
        },
      },
    },
  ]);
});

test('Codex interrupt targets the active thread and turn', async () => {
  const client = new FakeClient();
  const interaction = new CodexInteraction({ client });
  await interaction.sendExisting({
    sessionId: 'codex:thread-5',
    nativeSessionId: 'thread-5',
    streamId: 'stream-interrupt',
    text: 'keep working',
    callbacks: callbacks().value,
  });

  assert.equal(interaction.interrupt('thread-5'), true);
  assert.deepEqual(client.requests.at(-1), {
    method: 'turn/interrupt',
    params: {
      threadId: 'thread-5',
      turnId: 'turn-1',
    },
  });
});

test('burst sends to one Codex thread start one turn and queue the next', async () => {
  const client = new FakeClient();
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const request = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === 'thread/resume') await firstGate;
    return request(method, params);
  };
  const interaction = new CodexInteraction({ client });
  const first = callbacks();
  const second = callbacks();

  const firstSend = interaction.sendExisting({
    sessionId: 'codex:thread-burst',
    nativeSessionId: 'thread-burst',
    streamId: 'stream-burst-1',
    text: 'first',
    callbacks: first.value,
  });
  const secondSend = interaction.sendExisting({
    sessionId: 'codex:thread-burst',
    nativeSessionId: 'thread-burst',
    streamId: 'stream-burst-2',
    text: 'second',
    callbacks: second.value,
  });
  releaseFirst();

  assert.deepEqual(await firstSend, { queued: false });
  assert.deepEqual(await secondSend, { queued: true });
  assert.equal(client.requests.filter((entry) => entry.method === 'thread/resume').length, 1);
  assert.equal(client.requests.filter((entry) => entry.method === 'turn/start').length, 1);

  notify(client, 'turn/completed', {
    threadId: 'thread-burst',
    turn: { id: 'turn-1', status: 'completed' },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(client.requests.filter((entry) => entry.method === 'turn/start').length, 2);
  assert.equal(
    client.requests.filter((entry) => entry.method === 'turn/start')[1]
      .params.clientUserMessageId,
    'stream-burst-2',
  );
  assert.equal(client.stopCalls, 0);

  notify(client, 'turn/completed', {
    threadId: 'thread-burst',
    turn: { id: 'turn-2', status: 'completed' },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(client.stopCalls, 1);
});

test('different Codex threads use independent ephemeral clients', async () => {
  const clients = [];
  const interaction = new CodexInteraction({
    clientFactory() {
      const client = new FakeClient();
      clients.push(client);
      return client;
    },
  });

  await interaction.sendExisting({
    sessionId: 'codex:thread-a',
    nativeSessionId: 'thread-a',
    streamId: 'stream-a',
    text: 'a',
    callbacks: callbacks().value,
  });
  await interaction.sendExisting({
    sessionId: 'codex:thread-b',
    nativeSessionId: 'thread-b',
    streamId: 'stream-b',
    text: 'b',
    callbacks: callbacks().value,
  });

  assert.equal(clients.length, 2);
  notify(clients[0], 'turn/completed', {
    threadId: 'thread-a',
    turn: { id: 'turn-1', status: 'completed' },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(clients[0].stopCalls, 1);
  assert.equal(clients[1].stopCalls, 0);
  assert.equal(interaction.owns('thread-a'), false);
  assert.equal(interaction.owns('thread-b'), true);
});

test('send waits for an in-progress release before creating the next lease', async () => {
  const clients = [];
  let finishRelease;
  const interaction = new CodexInteraction({
    clientFactory() {
      const client = new FakeClient();
      if (clients.length === 0) {
        client.stop = () => {
          client.stopCalls++;
          client.started = false;
          return new Promise((resolve) => { finishRelease = resolve; });
        };
      }
      clients.push(client);
      return client;
    },
  });

  await interaction.sendExisting({
    sessionId: 'codex:thread-release',
    nativeSessionId: 'thread-release',
    streamId: 'stream-release-1',
    text: 'first',
    callbacks: callbacks().value,
  });
  notify(clients[0], 'turn/completed', {
    threadId: 'thread-release',
    turn: { id: 'turn-1', status: 'completed' },
  });

  const secondSend = interaction.sendExisting({
    sessionId: 'codex:thread-release',
    nativeSessionId: 'thread-release',
    streamId: 'stream-release-2',
    text: 'second',
    callbacks: callbacks().value,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(clients.length, 1);

  finishRelease();
  await secondSend;
  assert.equal(clients.length, 2);
  assert.equal(
    clients[1].requests.filter((entry) => entry.method === 'thread/resume').length,
    1,
  );
});

test('resume failure closes the unused ephemeral client', async () => {
  const client = new FakeClient();
  const request = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === 'thread/resume') {
      const error = new Error('thread already has an active writer');
      error.code = -32600;
      throw error;
    }
    return request(method, params);
  };
  const interaction = new CodexInteraction({
    client,
    writerController: {
      describe: () => ({
        pid: 88,
        tty: 'ttys008',
        label: 'Codex terminal (ttys008)',
        canTerminate: true,
        status: 'running',
      }),
      terminate: async () => {},
    },
  });

  await assert.rejects(
    interaction.sendExisting({
      sessionId: 'codex:thread-conflict',
      nativeSessionId: 'thread-conflict',
      streamId: 'stream-conflict',
      text: 'hello',
      callbacks: callbacks().value,
    }),
    (error) => error.code === 'CODEX_ACTIVE_WRITER'
      && error.writer.pid === 88,
  );

  assert.equal(client.stopCalls, 1);
  assert.equal(interaction.owns('thread-conflict'), false);
});

test('idle Codex writer is terminated automatically before resume', async () => {
  const client = new FakeClient();
  let locked = true;
  const request = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === 'thread/resume' && locked) {
      throw new Error('thread already has an active writer');
    }
    return request(method, params);
  };
  const terminated = [];
  const interaction = new CodexInteraction({
    client,
    writerController: {
      describe: () => ({
        pid: 90,
        tty: 'ttys009',
        label: 'Codex terminal (ttys009)',
        canTerminate: true,
        status: 'completed',
      }),
      terminate: async (threadId, expectedPid, options) => {
        terminated.push({ threadId, expectedPid, options });
        locked = false;
      },
    },
  });

  await interaction.sendExisting({
    sessionId: 'codex:thread-idle',
    nativeSessionId: 'thread-idle',
    streamId: 'stream-idle',
    text: 'continue',
    callbacks: callbacks().value,
  });

  assert.deepEqual(terminated, [{
    threadId: 'thread-idle',
    expectedPid: 90,
    options: { requireIdle: true },
  }]);
  assert.equal(
    client.requests.filter((entry) => entry.method === 'turn/start').length,
    1,
  );
});

test('confirmed takeover terminates the expected writer and retries resume in one client', async () => {
  const client = new FakeClient();
  let locked = true;
  const request = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === 'thread/resume' && locked) {
      throw new Error('thread already has an active writer');
    }
    return request(method, params);
  };
  const terminated = [];
  const interaction = new CodexInteraction({
    client,
    writerController: {
      describe: () => ({
        pid: 91,
        tty: 'ttys009',
        label: 'Codex terminal (ttys009)',
        canTerminate: true,
        status: 'running',
      }),
      terminate: async (threadId, expectedPid) => {
        terminated.push({ threadId, expectedPid });
        locked = false;
      },
    },
  });

  await interaction.sendExisting({
    sessionId: 'codex:thread-takeover',
    nativeSessionId: 'thread-takeover',
    streamId: 'stream-takeover',
    text: 'continue',
    takeover: true,
    expectedWriterPid: 91,
    callbacks: callbacks().value,
  });

  assert.deepEqual(terminated, [{
    threadId: 'thread-takeover',
    expectedPid: 91,
  }]);
  assert.equal(
    client.requests.filter((entry) => entry.method === 'thread/resume').length,
    1,
  );
  assert.equal(
    client.requests.filter((entry) => entry.method === 'turn/start').length,
    1,
  );
  assert.equal(client.generation, 1);
});

test('approval request ids are isolated across ephemeral clients', async () => {
  const clients = [];
  const interaction = new CodexInteraction({
    clientFactory() {
      const client = new FakeClient();
      clients.push(client);
      return client;
    },
  });
  const first = callbacks();
  const second = callbacks();

  await interaction.sendExisting({
    sessionId: 'codex:thread-control-a',
    nativeSessionId: 'thread-control-a',
    streamId: 'stream-control-a',
    text: 'a',
    callbacks: first.value,
  });
  await interaction.sendExisting({
    sessionId: 'codex:thread-control-b',
    nativeSessionId: 'thread-control-b',
    streamId: 'stream-control-b',
    text: 'b',
    callbacks: second.value,
  });

  for (const [index, client] of clients.entries()) {
    client.emit('serverRequest', {
      id: 42,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: `thread-control-${index === 0 ? 'a' : 'b'}`,
        turnId: 'turn-1',
        itemId: `command-${index}`,
        command: 'pwd',
      },
    });
  }

  assert.notEqual(first.controls[0].request_id, second.controls[0].request_id);
  assert.equal(
    interaction.replyControl(
      'thread-control-a',
      first.controls[0].request_id,
      { decision: 'allow' },
    ),
    true,
  );
  assert.equal(
    interaction.replyControl(
      'thread-control-b',
      second.controls[0].request_id,
      { decision: 'deny' },
    ),
    true,
  );
  assert.deepEqual(clients[0].responses[0], {
    id: 42,
    result: { decision: 'accept' },
  });
  assert.deepEqual(clients[1].responses[0], {
    id: 42,
    result: { decision: 'decline' },
  });
});

test('shutdown closes every active ephemeral client and drops pending ownership', async () => {
  const clients = [];
  const interaction = new CodexInteraction({
    clientFactory() {
      const client = new FakeClient();
      clients.push(client);
      return client;
    },
  });

  await interaction.sendExisting({
    sessionId: 'codex:shutdown-a',
    nativeSessionId: 'shutdown-a',
    streamId: 'shutdown-stream-a',
    text: 'a',
    callbacks: callbacks().value,
  });
  await interaction.sendExisting({
    sessionId: 'codex:shutdown-b',
    nativeSessionId: 'shutdown-b',
    streamId: 'shutdown-stream-b',
    text: 'b',
    callbacks: callbacks().value,
  });

  assert.equal(interaction.owns('shutdown-a'), true);
  assert.equal(interaction.owns('shutdown-b'), true);
  await interaction.shutdown();
  assert.deepEqual(clients.map((client) => client.stopCalls), [1, 1]);
  assert.equal(interaction.owns('shutdown-a'), false);
  assert.equal(interaction.owns('shutdown-b'), false);
});
