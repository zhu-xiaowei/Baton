import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexArchive } from '../../../bridge/codex-archive.mjs';
import { CodexInteraction } from '../../../bridge/codex-interaction.mjs';
import { readCodexArchiveTree } from '../../../bridge/codex-archive-tree.mjs';
import { randomUUID } from 'node:crypto';

function fixture(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-archive-'));
  const calls = [];
  const rows = new Map([
    ['root', { id: 'root', cwd: home, status: { type: 'idle' }, archived: false }],
    ['child', { id: 'child', parentThreadId: 'root', cwd: home, status: { type: 'idle' }, archived: false }],
  ]);
  const client = new EventEmitter();
  client.start = async () => {};
  client.stop = async () => {};
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/list') {
      return { data: [...rows.values()].filter((r) => r.archived === params.archived), nextCursor: null };
    }
    if (method === 'thread/read') return { thread: rows.get(params.threadId) };
    if (method === 'thread/archive') {
      rows.get(params.threadId).archived = true;
      if (params.threadId === 'root' && !options.partial) rows.get('child').archived = true;
      return {};
    }
    if (method === 'thread/unarchive') {
      rows.get(params.threadId).archived = false;
      return { thread: rows.get(params.threadId) };
    }
    throw new Error(`Unexpected mutation: ${method}`);
  };
  const uploads = [];
  const archive = new CodexArchive({
    homes: [home],
    stateFile: path.join(home, 'archive-state.json'),
    clientFactory: () => client,
    probe: async () => ({ supported: true }),
    writer: () => ({ occupied: false, verified: true }),
    isBusy: () => false,
    sync: async (observations) => uploads.push(observations),
    ...options,
  });
  t.after(async () => { await archive.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  return { archive, calls, rows, uploads, home, client };
}

test('archive and restore use native lifecycle methods without resuming or stopping a thread', async (t) => {
  const { archive, calls } = fixture(t);
  await archive.start();
  const result = await archive.setArchived('root', true);
  assert.equal(result.ok, true);
  assert.equal(archive.lookup('root').archiveState, 'archived');
  assert.equal(archive.lookup('child').archiveState, 'archived');
  assert.equal((await archive.setArchived('root', false)).ok, true);
  assert.equal(archive.lookup('root').archiveState, 'unarchived');
  assert.equal(archive.lookup('child').archiveState, 'archived');
  assert.deepEqual(calls.filter((c) => !['thread/list', 'thread/read'].includes(c.method)).map((c) => c.method),
    ['thread/archive', 'thread/unarchive']);
});

test('active descendants and external writers refuse archive without native mutation', async (t) => {
  const { archive, rows, calls } = fixture(t);
  await archive.start();
  rows.get('child').status = { type: 'active', activeFlags: ['waitingOnApproval'] };
  assert.equal((await archive.setArchived('root', true)).errorCode, 'session_active');
  rows.get('child').status = { type: 'idle' };
  archive.writer = () => ({ verified: true, occupied: true });
  assert.equal((await archive.setArchived('root', true)).errorCode, 'archive_writer_busy');
  assert.equal(calls.some((call) => call.method === 'thread/archive'), false);
});

test('archived ancestors block writes, while an explicitly restored root can accept work', async (t) => {
  const { archive } = fixture(t);
  await archive.start();
  await archive.setArchived('root', true);
  await assert.rejects(archive.withWritable('child', () => assert.fail('must remain read-only')), { code: 'session_archived' });
  await archive.setArchived('root', false);
  assert.equal(await archive.withWritable('root', () => 'sent'), 'sent');
  await assert.rejects(archive.withWritable('child', () => assert.fail('child was not restored')), { code: 'session_archived' });
});

test('partial native archive and failed persistence retain truthful state for retry', async (t) => {
  const { archive, rows } = fixture(t, { partial: true });
  await archive.start();
  const result = await archive.setArchived('root', true);
  assert.deepEqual(result.partial, ['codex:child']);
  assert.equal(rows.get('child').archived, false);
  archive.sync = async () => { throw new Error('offline'); };
  const restore = await archive.setArchived('root', false);
  assert.equal(restore.errorCode, 'archive_sync_pending');
  assert.equal(restore.nativeApplied, true);
  assert.equal(archive.lookup('root').archiveState, 'unarchived');
  let flushed = [];
  archive.sync = async (observations) => { flushed = observations; };
  await archive.refresh();
  assert.equal(flushed.find((r) => r.id === 'root').archiveState, 'unarchived');
});

test('all catalog pages include explicit child sources and every provider', async (t) => {
  const { archive, client, calls, rows } = fixture(t);
  const request = client.request;
  client.request = (method, params) => {
    if (method !== 'thread/list') return request(method, params);
    calls.push({ method, params });
    const entries = [...rows.values()].filter((row) => row.archived === params.archived);
    const index = Number(params.cursor || 0);
    return { data: entries.slice(index, index + 1), nextCursor: index + 1 < entries.length ? String(index + 1) : null };
  };
  await archive.start();
  assert.ok(archive.lookup('child'));
  assert.ok(calls.some((call) => call.params.cursor === '1'));
  for (const call of calls) {
    assert.ok(call.params.sourceKinds.includes('subAgentThreadSpawn'));
    assert.deepEqual(call.params.modelProviders, []);
  }
});

test('incomplete snapshots and disappearing files never infer archive state', async (t) => {
  const { archive, client, rows } = fixture(t);
  await archive.start();
  await archive.setArchived('root', true);
  const version = archive.lookup('root').archiveVersion;
  const request = client.request;
  client.request = (method, params) => {
    if (method === 'thread/list' && params.archived) throw new Error('second half unavailable');
    return request(method, params);
  };
  rows.get('root').archived = false;
  await archive.refresh();
  assert.equal(archive.lookup('root').archiveState, 'archived');
  assert.equal(archive.lookup('root').archiveVersion, version);
  await assert.rejects(archive.withWritable('root', () => assert.fail('unsafe send')), { code: 'archive_state_unknown' });
  client.request = request;
  rows.delete('child');
  await archive.refresh();
  assert.equal(archive.lookup('child').archiveState, 'archived');
  assert.equal((await archive.setArchived('root', true)).errorCode, 'archive_state_unknown');
});

test('external events remain authoritative when snapshots fail and do not start a turn', async (t) => {
  const { archive, client, calls } = fixture(t);
  await archive.start();
  client.request = async () => { throw new Error('disconnected'); };
  client.emit('notification', { method: 'thread/archived', params: { threadId: 'root' } });
  await archive.refresh();
  assert.equal(archive.lookup('root').archiveState, 'archived');
  assert.equal(calls.some((call) => call.method === 'thread/archive'), false);
});

test('a notification racing an old snapshot cannot revert the confirmed result', async (t) => {
  const { archive, client, rows } = fixture(t);
  await archive.start();
  const request = client.request;
  let raced = false;
  client.request = async (method, params) => {
    const response = await request(method, params);
    if (!raced && method === 'thread/list' && params.archived) {
      raced = true;
      rows.get('root').archived = true;
      client.emit('notification', { method: 'thread/archived', params: { threadId: 'root' } });
    }
    return response;
  };
  await archive.refresh();
  assert.equal(archive.lookup('root').archiveState, 'archived');
});

test('timeout after native success queries actual state instead of issuing a second mutation', async (t) => {
  const { archive, client, calls } = fixture(t);
  await archive.start();
  const request = client.request;
  client.request = async (method, params) => {
    const response = await request(method, params);
    if (method === 'thread/archive') throw new Error('thread/archive timed out');
    return response;
  };
  assert.equal((await archive.setArchived('root', true)).ok, true);
  assert.equal((await archive.setArchived('root', true)).ok, true);
  assert.equal(calls.filter((call) => call.method === 'thread/archive').length, 1);
});

test('restart replays unsynchronized native results without reversing them', async (t) => {
  const { archive, home, client } = fixture(t);
  await archive.start();
  archive.sync = async () => { throw new Error('server unavailable'); };
  assert.equal((await archive.setArchived('root', true)).nativeApplied, true);
  await archive.stop();
  const restored = new CodexArchive({
    homes: [home], stateFile: archive.stateFile, clientFactory: () => client,
    probe: archive.probe, writer: archive.writer, sync: async () => {},
  });
  t.after(() => restored.stop());
  await restored.start();
  assert.equal(restored.lookup('root').archiveState, 'archived');
  assert.equal(restored.pending.size, 0);
});

test('archive serializes with Baton sends and refuses a queued or active descendant', async (t) => {
  let release, entered;
  const sent = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const { archive, calls } = fixture(t);
  await archive.start();
  const sending = archive.withWritable('child', async () => {
    entered();
    await gate;
    archive.isBusy = (id) => id === 'child';
  });
  await sent;
  const archiving = archive.setArchived('root', true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.some((call) => call.method === 'thread/archive'), false);
  release();
  await sending;
  assert.equal((await archiving).errorCode, 'session_active');
});

test('multiple homes stay isolated and duplicate native IDs refuse all mutations', async (t) => {
  const first = fixture(t);
  const second = fixture(t);
  second.rows.clear();
  second.rows.set('other', { id: 'other', cwd: second.home, status: { type: 'idle' }, archived: false });
  const archive = new CodexArchive({
    homes: [first.home, second.home], stateFile: path.join(first.home, 'multi.json'),
    clientFactory: (home) => home === first.home ? first.client : second.client,
    probe: async () => ({ supported: true }), writer: () => ({ verified: true, occupied: false }),
    sync: async () => {},
  });
  t.after(() => archive.stop());
  await archive.start();
  assert.equal((await archive.setArchived('other', true)).ok, true);
  assert.equal(first.calls.some((call) => call.method === 'thread/archive'), false);
  second.rows.set('root', { ...first.rows.get('root') });
  await archive.refresh();
  assert.equal((await archive.setArchived('root', true)).errorCode, 'archive_home_conflict');
  await assert.rejects(archive.withWritable('root', () => assert.fail('ambiguous send')), { code: 'archive_home_conflict' });
});

test('archived history observation, commands and legacy sends never create an interaction client', async (t) => {
  const { archive } = fixture(t);
  await archive.start();
  await archive.setArchived('root', true);
  const interaction = new CodexInteraction({
    archives: archive,
    clientFactory: () => assert.fail('Archived sessions must never resume or acquire a writer'),
  });
  const options = { nativeSessionId: 'child', sessionId: 'codex:child' };
  await assert.rejects(interaction.sendExisting({ ...options, text: 'legacy send' }), { code: 'session_archived' });
  await assert.rejects(interaction.runCommand({ ...options, name: 'compact' }), { code: 'session_archived' });
  await assert.rejects(interaction.interrupt('child'), { code: 'session_archived' });
  assert.deepEqual(await interaction.observePermissions(options), { active: false, loaded: false });
});

test('/archive delegates to the native archive service before resume or writer takeover', async (t) => {
  const { archive, calls, home } = fixture(t);
  await archive.start();
  const interaction = new CodexInteraction({
    archives: archive,
    clientFactory: () => assert.fail('archive command must not open an interaction client'),
  });
  const result = await interaction.runCommand({ nativeSessionId: 'root', name: 'archive', cwd: home });
  assert.equal(result.action.type, 'leave-session');
  assert.equal(calls.some((call) => call.method === 'thread/resume'), false);
});

test('success requires persistence acknowledgements and version conflicts trigger fresh observation', async (t) => {
  const { archive, home } = fixture(t);
  await archive.start();
  const serverVersion = Date.now() + 10_000;
  archive.sync = async () => ({
    acknowledged: [],
    conflicts: [{ home, id: 'root', version: serverVersion }],
  });
  const result = await archive.setArchived('root', true);
  assert.equal(result.errorCode, 'archive_sync_pending');
  assert.equal(result.nativeApplied, true);
  assert.ok(archive.pending.has(`${home}:root`));
  archive.sync = async (observations) => ({ acknowledged: observations.map((record) => `${record.home}:${record.id}`) });
  await archive.refresh();
  assert.ok(archive.lookup('root').archiveVersion > serverVersion);
  assert.equal(archive.pending.size, 0);
});

test('transport-ordered sends waiting outside the runtime queue also block parent archive', async (t) => {
  const { archive } = fixture(t);
  await archive.start();
  const release = archive.trackPendingSend('child');
  assert.equal((await archive.setArchived('root', true)).errorCode, 'session_active');
  release();
  assert.equal((await archive.setArchived('root', true)).ok, true);
});

test('retry waits for descendant acknowledgements and retains partial native results', async (t) => {
  const { archive, calls, home } = fixture(t, { partial: true });
  await archive.start();
  archive.sync = async () => ({ acknowledged: [`${home}:root`] });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await archive.setArchived('root', true);
    assert.equal(result.ok, false);
    assert.equal(result.nativeApplied, true);
    assert.equal(result.errorCode, 'archive_sync_pending');
    assert.equal(archive.pending.has(`${home}:child`), true);
  }
  archive.sync = async () => ({ acknowledged: [`${home}:child`] });
  assert.deepEqual(await archive.setArchived('root', true), {
    sessionId: 'codex:root', ok: true, archiveState: 'archived', partial: ['codex:child'],
  });
  assert.equal(archive.pending.size, 0);
  assert.equal(calls.filter((call) => call.method === 'thread/archive').length, 1);
});

test('protocol failures reject writes from stale cache until a successful recheck', async (t) => {
  const first = fixture(t);
  await first.archive.start();
  await first.archive.stop();
  first.rows.get('root').archived = true;
  let failing = true;
  let probes = 0;
  const archive = new CodexArchive({
    homes: [first.home], stateFile: first.archive.stateFile,
    clientFactory: () => first.client,
    probe: async () => {
      probes++;
      if (failing) throw new Error('temporary generate-ts failure');
      return { supported: true };
    },
  });
  t.after(() => archive.stop());
  await archive.start();
  assert.equal(archive.supported, false);
  assert.ok(archive.timer, 'Unknown protocol must keep the polling fallback');
  assert.equal(archive.lookup('root').archiveState, 'archived', 'Read-only snapshots still calibrate state when mutation probing fails');
  await assert.rejects(archive.withWritable('child', () => assert.fail('must not resume')), { code: 'archive_state_unknown' });
  assert.equal((await archive.setArchived('child', true)).errorCode, 'archive_state_unknown');
  failing = false;
  await archive.refresh();
  assert.equal(archive.supported, true);
  assert.equal(archive.lookup('root').archiveState, 'archived');
  await assert.rejects(archive.withWritable('child', () => assert.fail('parent remains archived')), { code: 'session_archived' });
  assert.ok(probes > 1);
});

test('definitively unsupported old protocols retain existing send compatibility', async (t) => {
  const { archive } = fixture(t, { probe: async () => ({ supported: false }) });
  await archive.start();
  assert.equal(await archive.withWritable('root', () => 'sent'), 'sent');
  assert.equal((await archive.setArchived('root', true)).errorCode, 'archive_unsupported');
});

test('local topology includes metadata-only children without inventing archive state', (t) => {
  const { home } = fixture(t);
  const root = randomUUID(), child = randomUUID(), nested = randomUUID();
  const directory = path.join(home, 'sessions');
  fs.mkdirSync(directory);
  for (const [id, parent] of [[child, root], [nested, child]]) {
    fs.writeFileSync(path.join(directory, `rollout-${id}.jsonl`), JSON.stringify({
      type: 'session_meta', payload: {
        id, cwd: home, source: { subagent: { thread_spawn: { parent_thread_id: parent } } },
      },
    }) + '\n');
  }
  const records = new Map([[root, { id: root, home, parentThreadId: '', available: true, archiveState: 'unarchived' }]]);
  const tree = readCodexArchiveTree(home, records);
  assert.equal(tree.get(nested).parentThreadId, child);
  assert.equal(tree.get(child).available, false);
  assert.equal(tree.get(child).archiveState, 'unknown');
  assert.equal(records.has(child), false, 'Local files are topology evidence, not archive observations');
  fs.writeFileSync(path.join(directory, `rollout-${randomUUID()}.jsonl`), '{"incomplete":true}\n');
  assert.throws(() => readCodexArchiveTree(home, records), /ancestry/);
});

test('ordinary fork provenance is not subagent ancestry or a partial archive result', async (t) => {
  const { archive, rows, home } = fixture(t);
  const fork = randomUUID();
  const directory = path.join(home, 'sessions');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, `rollout-${fork}.jsonl`), JSON.stringify({
    type: 'session_meta', payload: { id: fork, cwd: home, source: 'cli', forked_from_id: 'root' },
  }) + '\n');
  rows.set(fork, {
    id: fork, cwd: home, parentThreadId: null, forkedFromId: 'root', archived: false,
    status: { type: 'active', activeFlags: [] },
  });
  await archive.start();
  assert.deepEqual(await archive.setArchived('root', true), {
    sessionId: 'codex:root', ok: true, archiveState: 'archived',
  });
  assert.equal(rows.get(fork).archived, false);
});

test('unlisted local descendants and incomplete topology refuse native archive', async (t) => {
  const { archive, calls } = fixture(t, {
    readTree: (home, records) => new Map([...records, ['hidden', {
      id: 'hidden', home, parentThreadId: 'child', available: false,
    }]]),
  });
  await archive.start();
  assert.equal((await archive.setArchived('root', true)).errorCode, 'archive_state_unknown');
  const release = archive.trackPendingSend('hidden');
  assert.equal((await archive.setArchived('root', true)).errorCode, 'session_active');
  release();
  archive.readTree = () => { throw new Error('rollout unreadable'); };
  assert.equal((await archive.setArchived('root', true)).errorCode, 'archive_state_unknown');
  assert.equal(calls.some((call) => call.method === 'thread/archive'), false);
});

test('runtime-only work absent from the catalog blocks archive, including late queued sends', async (t) => {
  const { archive, calls } = fixture(t, { busySessionIds: () => ['unlisted-runtime-child'] });
  await archive.start();
  assert.equal((await archive.setArchived('root', true)).errorCode, 'session_active');
  archive.busySessionIds = () => [];
  let release;
  archive.writer = () => {
    release ||= archive.trackPendingSend('late-unlisted-child');
    return { verified: true, occupied: false };
  };
  assert.equal((await archive.setArchived('root', true)).errorCode, 'session_active');
  release();
  assert.equal(calls.some((call) => call.method === 'thread/archive'), false);
});
