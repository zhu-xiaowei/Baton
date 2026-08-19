import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import {
  CodexWatcher,
} from '../../../bridge/codex-watcher.mjs';
import { deliverRealtimeMessages } from '../../../bridge/realtime-delivery.mjs';
import {
  clearLiveMessageRegistry,
  liveMessageRoute,
  markLiveMessagePushed,
  registerRuntimeOwnedMessage,
} from '../../../bridge/live-message-registry.mjs';
import { codexTurnLiveKey } from '../../../bridge/codex-live.mjs';
import { scanCodexRollout } from '../../../bridge/codex-session.mjs';
import { storageSessionId } from '../../../bridge/session-identity.mjs';

const IDS = [
  '019fb779-1111-7111-8111-111111111111',
  '019fb779-2222-7222-8222-222222222222',
  '019fb779-3333-7333-8333-333333333333',
];

function json(type, payload, second = 0) {
  return JSON.stringify({
    timestamp: `2026-08-09T12:00:${String(second).padStart(2, '0')}.000Z`,
    type,
    payload,
  });
}

function baseLines(id, cwd, options = {}) {
  const lines = [
    json('session_meta', {
      session_id: id,
      cwd,
      model_provider: 'test-provider',
      originator: 'codex-exec',
      cli_version: '0.147.0',
    }),
    json('turn_context', { model: 'test-model' }, 1),
    json('event_msg', { type: 'task_started', turn_id: 'turn-1' }, 2),
    json('event_msg', { type: 'user_message', message: options.user || 'hello' }, 3),
    json('response_item', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: options.assistant || 'world' }],
    }, 4),
  ];
  if (options.complete !== false) {
    lines.push(json('event_msg', { type: 'task_complete', turn_id: 'turn-1' }, 5));
  }
  return lines;
}

function createHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-codex-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function rolloutPath(home, id, day = '09') {
  const dir = path.join(home, 'sessions', '2026', '08', day);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `rollout-2026-08-${day}T12-00-00-${id}.jsonl`);
}

function writeLines(filePath, lines) {
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

function watcherHarness(homes, options = {}) {
  const delivered = [];
  const uploaded = [];
  const posts = [];
  const watermarks = options.watermarks || new Map();
  const watcher = new CodexWatcher({ deviceName: 'Codex-Test' }, {
    codexHomes: homes,
    initialSessions: options.initialSessions || [],
    watermarks,
    recentSessions: options.recentSessions || new Set(),
    lastKnownStatus: options.lastKnownStatus || new Map(),
    knownProjects: options.knownProjects || new Set(),
    deliverFn: options.deliverFn || (async (sessionId, messages, identity) => {
      delivered.push({ sessionId, messages, identity });
    }),
    uploadFn: options.uploadFn || (async (sessionId, messages, identity) => {
      uploaded.push({ sessionId, messages, identity });
    }),
    postFn: async (endpoint, body) => {
      posts.push({ endpoint, body });
      return { ok: true };
    },
    reconcileFn: async () => {},
    runningInfoFn: () => ({ projects: new Set(), sessions: new Set() }),
    ...(options.scanRollout ? { scanRollout: options.scanRollout } : {}),
    ...(options.subscribeFn ? { subscribeFn: options.subscribeFn } : {}),
    ...(options.watchFileFn ? { watchFileFn: options.watchFileFn } : {}),
    ...(options.runtimeOwnsFn ? { runtimeOwnsFn: options.runtimeOwnsFn } : {}),
    ...(options.recentFileWatchLimit !== undefined
      ? { recentFileWatchLimit: options.recentFileWatchLimit }
      : {}),
    ...(options.rescanMs ? { rescanMs: options.rescanMs } : {}),
    ...(options.watchRetryMs ? { watchRetryMs: options.watchRetryMs } : {}),
    retryMs: 60_000,
    statusRecheckMs: 60_000,
  });
  return { watcher, delivered, uploaded, posts, watermarks };
}

test('Codex watcher sends new lines once and preserves a partial trailing line', async (t) => {
  const home = createHome(t);
  const filePath = rolloutPath(home, IDS[0]);
  const lines = baseLines(IDS[0], home);
  writeLines(filePath, lines);
  const h = watcherHarness([home]);
  t.after(() => h.watcher.stop());

  await h.watcher.scanNow({ initial: true });
  assert.deepEqual(h.delivered.flatMap((batch) => batch.messages).map((message) => message.type), [
    'user',
    'assistant',
    'assistant',
  ]);
  const lifecycle = h.delivered[0].messages.at(-1);
  assert.deepEqual(lifecycle.content, []);
  assert.equal(lifecycle.stopReason, 'end_turn');
  assert.equal(h.watermarks.get(storageSessionId('codex', IDS[0])), lines.length);
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].body.statusDelta.from, 'new');

  await h.watcher.scanNow();
  assert.equal(h.delivered.length, 1);

  const call = json('response_item', {
    type: 'function_call',
    name: 'exec_command',
    arguments: JSON.stringify({ cmd: 'printf hello' }),
    call_id: 'call-1',
  }, 6);
  const partial = '{"timestamp":"2026-08-09T12:00:07.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","output":"hel';
  fs.appendFileSync(filePath, `${call}\n${partial}`);
  await h.watcher.scanNow();
  assert.equal(h.delivered.length, 2);
  assert.equal(h.delivered[1].messages[0].content[0].type, 'tool_use');
  assert.equal(h.watermarks.get(storageSessionId('codex', IDS[0])), lines.length + 1);

  fs.appendFileSync(filePath, 'lo"}}\n');
  await h.watcher.scanNow();
  assert.equal(h.delivered.length, 3);
  assert.equal(h.delivered[2].messages[0].content[0].type, 'tool_result');
  assert.equal(h.delivered[2].messages[0].content[0].content, 'hello');
  assert.equal(h.watermarks.get(storageSessionId('codex', IDS[0])), lines.length + 2);

  const uuids = h.delivered.flatMap((batch) => batch.messages).map((message) => message.uuid);
  assert.equal(new Set(uuids).size, uuids.length);
  await h.watcher.scanNow();
  assert.equal(h.delivered.length, 3);
});

test('Codex watcher keeps its watermark when delivery fails', async (t) => {
  const home = createHome(t);
  const filePath = rolloutPath(home, IDS[1]);
  writeLines(filePath, baseLines(IDS[1], home));
  let fail = true;
  const delivered = [];
  const h = watcherHarness([home], {
    deliverFn: async (_sessionId, messages) => {
      if (fail) throw new Error('offline');
      delivered.push(...messages);
    },
  });
  t.after(() => h.watcher.stop());

  await assert.rejects(() => h.watcher.processFile(filePath), /offline/);
  assert.equal(h.watermarks.has(storageSessionId('codex', IDS[1])), false);

  fail = false;
  await h.watcher.processFile(filePath);
  assert.equal(delivered.length, 3);
  assert.equal(delivered.at(-1).stopReason, 'end_turn');
  assert.equal(h.watermarks.get(storageSessionId('codex', IDS[1])), 6);
});

test('Codex watcher persists live user and assistant rows without broadcasting them again', async (t) => {
  const home = createHome(t);
  const filePath = rolloutPath(home, IDS[2]);
  const clientId = 'stream-live-test';
  const assistantId = 'msg-live-test';
  writeLines(filePath, [
    json('session_meta', {
      session_id: IDS[2],
      cwd: home,
      model_provider: 'test-provider',
      originator: 'codex-exec',
      cli_version: '0.147.0',
    }),
    json('event_msg', { type: 'task_started', turn_id: 'turn-live' }, 1),
    json('response_item', {
      id: 'msg-user-live-test',
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hello live' }],
      internal_chat_message_metadata_passthrough: { turn_id: 'turn-live' },
    }, 2),
    json('event_msg', {
      type: 'item_completed',
      turn_id: 'turn-live',
      item: {
        type: 'UserMessage',
        id: 'user-live-test',
        client_id: clientId,
        content: [{ type: 'text', text: 'hello live' }],
      },
    }, 3),
    json('response_item', {
      id: assistantId,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'world live' }],
    }, 4),
    json('event_msg', { type: 'task_complete', turn_id: 'turn-live' }, 5),
  ]);

  const persisted = [];
  const h = watcherHarness([home], {
    uploadFn: async (sessionId, messages, identity) => {
      persisted.push({ sessionId, messages, identity });
    },
  });
  t.after(() => {
    h.watcher.stop();
    clearLiveMessageRegistry();
  });
  markLiveMessagePushed('codex', codexTurnLiveKey('turn-live'));

  await h.watcher.scanNow({ initial: true });

  assert.equal(h.delivered.length, 0);
  assert.deepEqual(
    persisted.flatMap((batch) => batch.messages).map((message) => message.type),
    ['user', 'assistant', 'assistant'],
  );
  assert.deepEqual(
    persisted.flatMap((batch) => batch.messages)
      .filter((message) => message.nativeId)
      .map((message) => message.nativeId),
    [`codex:user:${clientId}`, `codex:item:${assistantId}`],
  );
  assert.equal(
    persisted.flatMap((batch) => batch.messages).at(-1).stopReason,
    'end_turn',
  );
});

test('Codex watcher only persists runtime-owned authority before live publish', async (t) => {
  const home = createHome(t);
  const filePath = rolloutPath(home, IDS[1]);
  const assistantId = 'runtime-owned-assistant';
  writeLines(filePath, [
    json('session_meta', {
      session_id: IDS[1],
      cwd: home,
      model_provider: 'test-provider',
      originator: 'codex-exec',
      cli_version: '0.147.0',
    }),
    json('event_msg', { type: 'task_started', turn_id: 'turn-runtime' }, 1),
    json('response_item', {
      id: assistantId,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'runtime authority' }],
    }, 2),
  ]);

  const persisted = [];
  const h = watcherHarness([home], {
    uploadFn: async (sessionId, messages, identity) => {
      persisted.push({ sessionId, messages, identity });
    },
  });
  t.after(() => {
    h.watcher.stop();
    clearLiveMessageRegistry();
  });
  registerRuntimeOwnedMessage('codex', codexTurnLiveKey('turn-runtime'));

  await h.watcher.scanNow({ initial: true });

  assert.equal(h.delivered.some((batch) =>
    batch.messages.some((message) =>
      message.nativeId === `codex:item:${assistantId}`)), false);
  assert.equal(persisted.some((batch) =>
    batch.messages.some((message) =>
      message.nativeId === `codex:item:${assistantId}`)), true);
});

test('Codex watcher persists every row while app-server owns the session', async (t) => {
  const home = createHome(t);
  const filePath = rolloutPath(home, IDS[1]);
  writeLines(filePath, [
    ...baseLines(IDS[1], home, { complete: false }),
    json('response_item', {
      type: 'function_call',
      name: 'exec_command',
      arguments: JSON.stringify({ cmd: 'printf runtime-owned' }),
      call_id: 'runtime-owned-command',
    }, 5),
    json('response_item', {
      type: 'function_call_output',
      call_id: 'runtime-owned-command',
      output: 'runtime-owned',
      status: 'completed',
    }, 6),
    json('event_msg', { type: 'task_complete', turn_id: 'turn-1' }, 7),
  ]);
  const h = watcherHarness([home], {
    runtimeOwnsFn: (nativeSessionId) => nativeSessionId === IDS[1],
  });
  t.after(() => {
    h.watcher.stop();
    clearLiveMessageRegistry();
  });

  await h.watcher.scanNow({ initial: true });

  assert.equal(h.delivered.length, 0);
  const persisted = h.uploaded.flatMap((batch) => batch.messages);
  assert.deepEqual(persisted.map((message) => message.type), [
    'user',
    'assistant',
    'assistant',
    'user',
    'assistant',
  ]);
  assert.deepEqual(
    persisted.flatMap((message) => (
      Array.isArray(message.content)
        ? message.content.map((block) => block.type)
        : []
    )),
    ['text', 'tool_use', 'tool_result'],
  );
});

test('Codex watcher keeps a completed runtime turn storage-only through its JSONL terminal row', async (t) => {
  const home = createHome(t);
  const filePath = rolloutPath(home, IDS[1]);
  const turnId = 'turn-runtime-interrupted';
  const lines = [
    json('session_meta', {
      session_id: IDS[1],
      cwd: home,
      model_provider: 'test-provider',
      originator: 'codex-exec',
      cli_version: '0.147.0',
    }),
    json('event_msg', { type: 'task_started', turn_id: turnId }, 1),
    json('response_item', {
      type: 'function_call',
      name: 'exec_command',
      arguments: JSON.stringify({ cmd: 'sleep 10' }),
      call_id: 'runtime-interrupted-command',
    }, 2),
    json('event_msg', {
      type: 'turn_aborted',
      turn_id: turnId,
      reason: 'interrupted',
    }, 3),
    json('response_item', {
      type: 'function_call_output',
      call_id: 'runtime-interrupted-command',
      output: '',
      status: 'failed',
    }, 4),
  ];
  writeLines(filePath, lines);
  const h = watcherHarness([home], {
    runtimeOwnsFn: () => false,
  });
  t.after(() => {
    h.watcher.stop();
    clearLiveMessageRegistry();
  });
  registerRuntimeOwnedMessage('codex', codexTurnLiveKey(turnId));

  await h.watcher.scanNow({ initial: true });

  assert.equal(h.delivered.length, 0);
  const persisted = h.uploaded.flatMap((batch) => batch.messages);
  assert.deepEqual(
    persisted.flatMap((message) => (
      Array.isArray(message.content)
        ? message.content.map((block) => block.type)
        : []
    )),
    ['tool_use', 'text', 'tool_result'],
  );
  assert.equal(
    persisted[1].content[0].text,
    '[Request interrupted by user]',
  );
  assert.equal(
    liveMessageRoute('codex', codexTurnLiveKey(turnId))?.runtimeOwned,
    true,
  );

  lines.push(json('event_msg', {
    type: 'task_started',
    turn_id: 'turn-after-interrupt',
  }, 5));
  writeLines(filePath, lines);
  await h.watcher.scanNow();

  assert.equal(liveMessageRoute('codex', codexTurnLiveKey(turnId)), null);
});

test('Codex watcher still broadcasts an external TUI interrupted turn without runtime ownership', async (t) => {
  const home = createHome(t);
  const filePath = rolloutPath(home, IDS[1]);
  const turnId = 'turn-tui-interrupted';
  writeLines(filePath, [
    json('session_meta', {
      session_id: IDS[1],
      cwd: home,
      model_provider: 'test-provider',
      originator: 'codex-cli',
      cli_version: '0.147.0',
    }),
    json('event_msg', { type: 'task_started', turn_id: turnId }, 1),
    json('response_item', {
      type: 'function_call',
      name: 'exec_command',
      arguments: JSON.stringify({ cmd: 'sleep 10' }),
      call_id: 'tui-interrupted-command',
    }, 2),
    json('event_msg', {
      type: 'turn_aborted',
      turn_id: turnId,
      reason: 'interrupted',
    }, 3),
  ]);
  const h = watcherHarness([home], {
    runtimeOwnsFn: () => false,
  });
  t.after(() => {
    h.watcher.stop();
    clearLiveMessageRegistry();
  });

  await h.watcher.scanNow({ initial: true });

  const delivered = h.delivered.flatMap((batch) => batch.messages);
  assert.deepEqual(
    delivered.flatMap((message) => (
      Array.isArray(message.content)
        ? message.content.map((block) => block.type)
        : []
    )),
    ['tool_use', 'text'],
  );
  assert.equal(
    delivered.at(-1).content[0].text,
    '[Request interrupted by user]',
  );
});

test('Codex watcher skips rollout status scans for ordinary tool appends', async (t) => {
  const home = createHome(t);
  const filePath = rolloutPath(home, IDS[0]);
  const lines = baseLines(IDS[0], home);
  writeLines(filePath, lines);
  let scans = 0;
  const h = watcherHarness([home], {
    scanRollout: (...args) => {
      scans++;
      return scanCodexRollout(...args);
    },
  });
  t.after(() => h.watcher.stop());

  await h.watcher.scanNow({ initial: true });
  assert.equal(scans, 1);

  fs.appendFileSync(filePath, `${json('response_item', {
    type: 'function_call',
    name: 'exec_command',
    arguments: JSON.stringify({ cmd: 'printf hello' }),
    call_id: 'call-status-scan',
  }, 6)}\n`);
  await h.watcher.scanNow();
  assert.equal(scans, 1);

  fs.appendFileSync(filePath, `${json('event_msg', {
    type: 'task_started',
    turn_id: 'turn-2',
  }, 7)}\n`);
  await h.watcher.scanNow();
  assert.equal(scans, 2);
});

test('Codex watcher drains appends during delivery without another file event', async (t) => {
  const home = createHome(t);
  const filePath = rolloutPath(home, IDS[0]);
  const lines = baseLines(IDS[0], home);
  writeLines(filePath, lines);
  const key = storageSessionId('codex', IDS[0]);
  const delivered = [];
  let releaseFirst;
  let firstStarted;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const started = new Promise((resolve) => { firstStarted = resolve; });
  let batches = 0;
  const h = watcherHarness([home], {
    initialSessions: [{
      id: IDS[0],
      nativeSessionId: IDS[0],
      runtime: 'codex',
      project: '-test',
      lastActive: new Date().toISOString(),
      status: 'completed',
    }],
    watermarks: new Map([[key, lines.length]]),
    recentSessions: new Set([key]),
    lastKnownStatus: new Map([[key, 'completed']]),
    deliverFn: async (_sessionId, messages) => {
      delivered.push(...messages);
      batches++;
      if (batches === 1) {
        firstStarted();
        await firstGate;
      }
    },
  });
  t.after(() => h.watcher.stop());

  fs.appendFileSync(filePath, `${json('response_item', {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'first append' }],
  }, 6)}\n`);
  const first = h.watcher.queueFile(filePath);
  await started;

  fs.appendFileSync(filePath, `${json('response_item', {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'second append' }],
  }, 7)}\n`);
  releaseFirst();
  await first;

  assert.deepEqual(delivered.map((message) => message.content[0].text), [
    'first append',
    'second append',
  ]);
  assert.equal(h.watermarks.get(key), lines.length + 2);
});

test('Codex watcher uses one native root subscription and queues file events immediately', async (t) => {
  const home = createHome(t);
  const filePath = rolloutPath(home, IDS[0]);
  const lines = baseLines(IDS[0], home);
  writeLines(filePath, lines);
  const callbacks = [];
  const watched = [];
  const h = watcherHarness([home], {
    initialSessions: [{
      id: IDS[0],
      nativeSessionId: IDS[0],
      runtime: 'codex',
      project: '-test',
      lastActive: new Date().toISOString(),
      status: 'completed',
    }],
    watermarks: new Map([[storageSessionId('codex', IDS[0]), lines.length]]),
    recentSessions: new Set([storageSessionId('codex', IDS[0])]),
    lastKnownStatus: new Map([[storageSessionId('codex', IDS[0]), 'completed']]),
    subscribeFn: async (root, callback) => {
      watched.push(root);
      callbacks.push(callback);
      return { async unsubscribe() {} };
    },
  });
  t.after(() => h.watcher.stop());

  await h.watcher.ensureWatchers();
  assert.deepEqual(watched, [fs.realpathSync.native(path.join(home, 'sessions'))]);

  fs.appendFileSync(filePath, `${json('response_item', {
    type: 'function_call',
    name: 'exec_command',
    arguments: JSON.stringify({ cmd: 'printf immediate' }),
    call_id: 'call-immediate',
  }, 6)}\n`);
  callbacks[0](null, [{ type: 'update', path: filePath }]);
  await h.watcher.flush();

  assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0].messages[0].content[0].input.command, 'printf immediate');
});

test('Codex watcher observes active rollout appends when the root subscription emits nothing', async (t) => {
  const home = createHome(t);
  const filePath = rolloutPath(home, IDS[0]);
  const lines = baseLines(IDS[0], home);
  writeLines(filePath, lines);
  const key = storageSessionId('codex', IDS[0]);
  const h = watcherHarness([home], {
    initialSessions: [{
      id: IDS[0],
      nativeSessionId: IDS[0],
      runtime: 'codex',
      project: '-test',
      lastActive: new Date().toISOString(),
      status: 'completed',
    }],
    watermarks: new Map([[key, lines.length]]),
    recentSessions: new Set([key]),
    lastKnownStatus: new Map([[key, 'completed']]),
    rescanMs: 60_000,
    subscribeFn: async () => ({ async unsubscribe() {} }),
  });
  t.after(() => h.watcher.stop());

  h.watcher.start();
  await h.watcher.readyPromise;
  assert.equal(h.watcher.watchHandles.size, 1);
  assert.equal(h.watcher.fileWatchers.size, 1);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const appends = ['first parcel append', 'second parcel append', 'third parcel append'];
  fs.appendFileSync(filePath, `${appends.map((text, index) => json('response_item', {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  }, index + 6)).join('\n')}\n`);

  const deliveryDeadline = Date.now() + 2000;
  while (h.delivered.flatMap((batch) => batch.messages).length < appends.length
    && Date.now() < deliveryDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const messages = h.delivered.flatMap((batch) => batch.messages);
  assert.deepEqual(messages.map((message) => message.content[0].text), appends);
  assert.equal(new Set(messages.map((message) => message.uuid)).size, appends.length);
  assert.equal(h.watermarks.get(key), lines.length + appends.length);
});

test('Codex watcher directly watches all running sessions plus a bounded recent set', async (t) => {
  const home = createHome(t);
  const initialSessions = [];
  const watermarks = new Map();
  const recentSessions = new Set();
  const statuses = new Map();
  const paths = [];

  for (let index = 0; index < 10; index++) {
    const id = `019fb779-${String(index).padStart(4, '0')}-7000-8000-${String(index).padStart(12, '0')}`;
    const filePath = rolloutPath(home, id, String(10 + index));
    writeLines(filePath, baseLines(id, home));
    const mtime = new Date(Date.now() - (10 - index) * 1000);
    fs.utimesSync(filePath, mtime, mtime);
    const key = storageSessionId('codex', id);
    const status = index < 2 ? 'running' : 'completed';
    initialSessions.push({
      id,
      nativeSessionId: id,
      runtime: 'codex',
      project: '-test',
      lastActive: mtime.toISOString(),
      status,
    });
    watermarks.set(key, 6);
    recentSessions.add(key);
    statuses.set(key, status);
    paths.push(fs.realpathSync.native(filePath));
  }

  const h = watcherHarness([home], {
    initialSessions,
    watermarks,
    recentSessions,
    lastKnownStatus: statuses,
    recentFileWatchLimit: 3,
    subscribeFn: async () => ({ async unsubscribe() {} }),
  });
  t.after(() => h.watcher.stop());

  h.watcher.start();
  await h.watcher.readyPromise;

  assert.equal(h.watcher.watchHandles.size, 1);
  assert.equal(h.watcher.fileWatchers.size, 5);
  assert.equal(h.watcher.fileWatchers.has(paths[0]), true);
  assert.equal(h.watcher.fileWatchers.has(paths[1]), true);
  assert.deepEqual(
    paths.slice(2).filter((filePath) => h.watcher.fileWatchers.has(filePath)),
    paths.slice(-3),
  );
});

test('Codex watcher does not rebuild the recent set for an already watched append', async (t) => {
  const home = createHome(t);
  const filePath = rolloutPath(home, IDS[0]);
  const lines = baseLines(IDS[0], home);
  writeLines(filePath, lines);
  const key = storageSessionId('codex', IDS[0]);
  const h = watcherHarness([home], {
    initialSessions: [{
      id: IDS[0],
      nativeSessionId: IDS[0],
      runtime: 'codex',
      project: '-test',
      lastActive: new Date().toISOString(),
      status: 'completed',
    }],
    watermarks: new Map([[key, lines.length]]),
    recentSessions: new Set([key]),
    lastKnownStatus: new Map([[key, 'completed']]),
    subscribeFn: async () => ({ async unsubscribe() {} }),
  });
  t.after(() => h.watcher.stop());

  await h.watcher.scanNow({ initial: true });
  assert.equal(h.watcher.fileWatchers.has(fs.realpathSync.native(filePath)), true);

  const desiredFileWatchPaths = h.watcher.desiredFileWatchPaths.bind(h.watcher);
  let recomputes = 0;
  h.watcher.desiredFileWatchPaths = () => {
    recomputes++;
    return desiredFileWatchPaths();
  };

  fs.appendFileSync(filePath, `${json('response_item', {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'watched append' }],
  }, 6)}\n`);
  await h.watcher.queueChangedFile(fs.realpathSync.native(filePath));

  assert.equal(recomputes, 0);
  assert.equal(h.delivered.at(-1).messages[0].content[0].text, 'watched append');
});

test('Codex watcher rescans changes immediately after a watcher retry', async (t) => {
  const home = createHome(t);
  const filePath = rolloutPath(home, IDS[0]);
  writeLines(filePath, baseLines(IDS[0], home));
  let attempts = 0;
  const h = watcherHarness([home], {
    watchRetryMs: 5,
    subscribeFn: async () => {
      attempts++;
      if (attempts === 1) throw new Error('temporary watcher failure');
      return { async unsubscribe() {} };
    },
  });
  t.after(() => h.watcher.stop());

  await h.watcher.ensureWatchers();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await h.watcher.flush();

  assert.equal(attempts, 2);
  assert.deepEqual(h.delivered.flatMap((batch) => batch.messages).map((message) => message.type), [
    'user',
    'assistant',
    'assistant',
  ]);
  assert.equal(
    h.delivered.flatMap((batch) => batch.messages).at(-1).stopReason,
    'end_turn',
  );
});

test('Codex watcher handles rename, multiple homes, and running to completed status', async (t) => {
  const firstHome = createHome(t);
  const secondHome = createHome(t);
  const firstPath = rolloutPath(firstHome, IDS[0]);
  const firstLines = baseLines(IDS[0], firstHome, { complete: false });
  writeLines(firstPath, firstLines);
  const firstKey = storageSessionId('codex', IDS[0]);
  const h = watcherHarness([firstHome, secondHome], {
    initialSessions: [{
      id: IDS[0],
      nativeSessionId: IDS[0],
      runtime: 'codex',
      lastActive: new Date().toISOString(),
      status: 'running',
    }],
    watermarks: new Map([[firstKey, firstLines.length]]),
    recentSessions: new Set([firstKey]),
    lastKnownStatus: new Map([[firstKey, 'running']]),
  });
  t.after(() => h.watcher.stop());

  await h.watcher.scanNow({ initial: true });
  assert.equal(h.delivered.length, 0);

  const renamed = rolloutPath(firstHome, IDS[0], '10');
  fs.renameSync(firstPath, renamed);
  fs.appendFileSync(renamed, `${json('event_msg', { type: 'task_complete', turn_id: 'turn-1' }, 6)}\n`);

  const secondPath = rolloutPath(secondHome, IDS[2]);
  writeLines(secondPath, baseLines(IDS[2], secondHome, {
    user: 'second home',
    assistant: 'second result',
  }));
  await h.watcher.scanNow();

  assert.equal(h.watermarks.get(firstKey), firstLines.length + 1);
  assert.equal(h.posts.some((entry) => entry.body.statusDelta?.to === 'completed'), true);
  assert.equal(h.delivered.some((entry) => entry.sessionId === storageSessionId('codex', IDS[2])), true);
});

test('Realtime delivery uses WS ack, HTTP fallback, and a truncated oversized preview', async () => {
  const message = {
    uuid: 'm1',
    type: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    timestamp: '2026-08-09T12:00:00.000Z',
  };
  const secondMessage = {
    ...message,
    uuid: 'm2',
    content: [{ type: 'text', text: 'second' }],
  };
  const sent = [];
  const uploaded = [];

  await deliverRealtimeMessages('codex:test', [message, secondMessage], {
    wsSendWithAckFn: async (payload) => {
      sent.push(payload);
      return true;
    },
    wsSendFn: (payload) => sent.push(payload),
    uploadMessagesFn: async (...args) => uploaded.push(args),
  });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].messages.map((item) => item.uuid), ['m1', 'm2']);
  assert.equal(uploaded.length, 0);

  await deliverRealtimeMessages('codex:test', [message, secondMessage], {
    wsSendWithAckFn: async () => false,
    wsSendFn: () => true,
    uploadMessagesFn: async (...args) => uploaded.push(args),
    runtime: 'codex',
    nativeSessionId: 'test',
  });
  assert.equal(uploaded.length, 1);
  assert.deepEqual(uploaded[0][1].map((item) => item.uuid), ['m1', 'm2']);
  assert.equal(uploaded[0][2].runtime, 'codex');

  const large = {
    ...message,
    uuid: 'large',
    content: [{ type: 'text', text: 'x'.repeat(5000) }],
  };
  const oversizedSent = [];
  const oversizedUploads = [];
  await deliverRealtimeMessages('codex:test', [large], {
    frameLimit: 1200,
    itemLimit: 10_000,
    wsSendFn: (payload) => {
      oversizedSent.push(payload);
      return true;
    },
    wsSendWithAckFn: async () => {
      throw new Error('oversized messages must not use ack path');
    },
    uploadMessagesFn: async (...args) => oversizedUploads.push(args),
  });
  assert.equal(oversizedSent[0].noCache, true);
  assert.equal(oversizedSent[0].messages[0].truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(oversizedSent[0])) < 1200);
  assert.equal(oversizedUploads[0][1][0].content[0].text.length, 5000);
});
