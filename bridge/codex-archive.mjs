import fs from 'node:fs';
import path from 'node:path';
import { CodexAppServerClient } from './codex-app-server.mjs';
import { BRIDGE_HOME } from './config.mjs';
import { resolveCodexHomes } from './runtime-capabilities.mjs';
import { publishCodexArchiveRecords, safeCodexArchivePath } from './codex-archive-index.mjs';
import { probeCodexArchiveProtocol } from './codex-archive-protocol.mjs';
import { inspectCodexArchiveWriter } from './codex-writer.mjs';
import { readCodexArchiveTree } from './codex-archive-tree.mjs';
import { observeCodexStatus } from './codex-status.mjs';

export const CODEX_ARCHIVE_POLL_MS = 60_000;
const SOURCE_KINDS = [
  'cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
  'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown',
];

function archiveError(code, message) {
  return Object.assign(new Error(message), { code });
}

export class CodexArchive {
  constructor(options = {}) {
    this.homes = [...new Set((options.homes || resolveCodexHomes()).map((home) => {
      try { return fs.realpathSync(home); } catch { return path.resolve(home); }
    }))];
    this.stateFile = options.stateFile || path.join(BRIDGE_HOME, 'codex-archives.json');
    this.clientFactory = options.clientFactory || ((home) => new CodexAppServerClient({
      cwd: home, codexHomes: [home], env: { ...process.env, CODEX_HOME: home },
      requestTimeout: 15_000,
    }));
    this.probe = options.probe || probeCodexArchiveProtocol;
    this.writer = options.writer || inspectCodexArchiveWriter;
    this.isBusy = options.isBusy || (() => false);
    this.busySessionIds = options.busySessionIds || (() => []);
    this.readTree = options.readTree || readCodexArchiveTree;
    this.sync = options.sync || null;
    this.records = new Map(this.homes.map((home) => [home, new Map()]));
    this.clients = new Map();
    this.pending = new Map();
    this.events = new Map();
    this.rechecks = new Set();
    this.pendingSends = new Map();
    this.generation = 0;
    this.version = 0;
    this.tail = Promise.resolve();
    this.enabled = false;
    this.supported = false;
    this.protocolState = 'unknown';
    this.stopped = false;
  }

  #run(operation) {
    const next = this.tail.then(operation);
    this.tail = next.catch(() => {});
    return next;
  }

  lookup(id) {
    const matches = [...this.records.values()].flatMap((records) => (
      records.has(id) ? [records.get(id)] : []
    ));
    if (matches.length > 1) throw archiveError('archive_home_conflict', 'Session exists in multiple Codex homes.');
    return matches[0] || null;
  }

  trackPendingSend(id) {
    this.pendingSends.set(id, (this.pendingSends.get(id) || 0) + 1);
    return () => {
      const count = (this.pendingSends.get(id) || 1) - 1;
      if (count) this.pendingSends.set(id, count);
      else this.pendingSends.delete(id);
    };
  }

  #save() {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({
      version: this.version,
      homes: [...this.records].map(([home, records]) => [home, [...records]]),
      pending: [...this.pending],
      rechecks: [...this.rechecks],
    }), { mode: 0o600 });
    fs.renameSync(temporary, this.stateFile);
  }

  #load() {
    if (!fs.existsSync(this.stateFile)) return;
    const saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    this.version = Number(saved.version) || 0;
    for (const [home, records] of saved.homes || []) {
      if (!this.records.has(home)) continue;
      this.records.set(home, new Map(records.map(([id, record]) => [id, { ...record, statusReobserve: true }])));
      publishCodexArchiveRecords(home, this.records.get(home));
    }
    this.pending = new Map(saved.pending || []);
    this.rechecks = new Set(saved.rechecks || []);
  }

  async start() {
    try { this.#load(); } catch (error) {
      console.warn(`[archive] cache ignored: ${error.message}`);
    }
    for (const [home, records] of this.records) {
      for (const [id, record] of records) this.pending.set(`${home}:${id}`, record);
    }
    this.enabled = true;
    this.timer = setInterval(() => {
      this.refresh().catch((error) => console.warn(`[archive] refresh: ${error.message}`));
    }, CODEX_ARCHIVE_POLL_MS);
    this.timer.unref?.();
    await this.refresh();
  }

  async #probe() {
    if (this.protocolState !== 'unknown') return;
    try {
      const capability = await this.probe();
      if (typeof capability?.supported !== 'boolean') throw new Error('Invalid Codex protocol probe result.');
      this.supported = capability.supported;
      this.protocolState = this.supported ? 'supported' : 'unsupported';
    } catch (error) {
      this.supported = false;
      console.warn(`[archive] protocol verification pending: ${error.message}`);
    }
  }

  async #client(home) {
    let client = this.clients.get(home);
    if (!client) {
      client = this.clientFactory(home);
      this.clients.set(home, client);
      client.on('notification', ({ method, params }) => {
        if (!['thread/archived', 'thread/unarchived', 'thread/started', 'thread/status/changed'].includes(method)) return;
        this.generation++;
        if (params?.threadId && method !== 'thread/started') {
          const key = `${home}:${params.threadId}`;
          this.events.set(key, {
            ...this.events.get(key), home, id: params.threadId,
            ...(method === 'thread/status/changed'
              ? { status: params.status, managed: !!client.socketTransport?.writable, observedAt: Date.now() }
              : { archiveState: method === 'thread/archived' ? 'archived' : 'unarchived' }),
          });
        }
        this.#scheduleRefresh();
      });
      client.on('ready', () => this.#scheduleRefresh());
    }
    await client.start();
    return client;
  }

  #scheduleRefresh() {
    if (this.stopped) return;
    if (this.refreshScheduled) { this.refreshAgain = true; return; }
    this.refreshScheduled = true;
    queueMicrotask(() => {
      this.refresh().catch((error) => console.warn(`[archive] synchronization: ${error.message}`))
        .finally(() => {
          this.refreshScheduled = false;
          if (this.refreshAgain) { this.refreshAgain = false; this.#scheduleRefresh(); }
        });
    });
  }

  #applyEvents(home) {
    const records = this.records.get(home);
    for (const [key, event] of this.events) {
      if (event.home !== home || !records.has(event.id)) continue;
      const previous = records.get(event.id);
      const archiveVersion = event.archiveState
        ? Math.max(Date.now(), this.version + 1) : previous.archiveVersion;
      this.version = Math.max(this.version, archiveVersion);
      const record = {
        ...previous,
        ...(event.archiveState ? { archiveState: event.archiveState, archiveVersion } : {}),
        ...(event.status ? {
          status: event.status,
          ...observeCodexStatus(previous, event.status, event.managed, event.observedAt),
        } : {}),
      };
      records.set(event.id, record);
      this.pending.set(key, record);
      this.events.delete(key);
    }
  }

  async #list(client, archived) {
    const rows = [];
    const cursors = new Set();
    let cursor;
    do {
      const response = await client.request('thread/list', {
        archived, sourceKinds: SOURCE_KINDS, modelProviders: [], limit: 200, ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(response?.data) || !Object.hasOwn(response, 'nextCursor')
        || (response.nextCursor !== null && typeof response.nextCursor !== 'string')) {
        throw new Error('Invalid or incomplete Codex thread catalog');
      }
      rows.push(...response.data);
      cursor = response.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('Codex catalog cursor repeated');
      cursors.add(cursor);
    } while (cursor);
    return rows;
  }

  async #refresh() {
    const failures = new Set();
    for (const home of this.homes) {
      this.#applyEvents(home);
      try {
        const client = await this.#client(home);
        let unarchived, archived;
        for (let attempt = 0; attempt < 3; attempt++) {
          this.#applyEvents(home);
          const generation = this.generation;
          unarchived = await this.#list(client, false);
          archived = await this.#list(client, true);
          if (generation === this.generation) break;
          if (attempt === 2) throw new Error('Codex catalog changed during scan');
        }
        const ids = new Set();
        const rows = [...unarchived.map((thread) => [thread, 'unarchived']),
          ...archived.map((thread) => [thread, 'archived'])];
        for (const [thread] of rows) {
          if (!thread.id || ids.has(thread.id)) throw new Error('Inconsistent Codex catalog');
          ids.add(thread.id);
        }
        const records = this.records.get(home);
        for (const [thread, archiveState] of rows) {
          const previous = records.get(thread.id);
          const changed = previous?.archiveState !== archiveState || previous?.reobserve;
          const archiveVersion = changed ? Math.max(Date.now(), this.version + 1) : previous.archiveVersion;
          this.version = Math.max(this.version, archiveVersion);
          const record = {
            id: thread.id, home, archiveState, archiveVersion,
            available: true,
            cwd: thread.cwd || previous?.cwd || '',
            path: safeCodexArchivePath(home, thread.path) || previous?.path || '',
            parentThreadId: thread.parentThreadId || previous?.parentThreadId || '',
            preview: thread.name || thread.preview || previous?.preview || '',
            status: thread.status,
            ...observeCodexStatus(previous, thread.status, !!client.socketTransport?.writable),
            lastActive: Number.isFinite(thread.updatedAt) ? new Date(thread.updatedAt * 1000).toISOString() : previous?.lastActive,
          };
          records.set(thread.id, record);
          if (changed || previous?.path !== record.path || previous?.preview !== record.preview
            || previous?.statusVersion !== record.statusVersion
            || previous?.lastActive !== record.lastActive
            || this.pending.has(`${home}:${thread.id}`) || this.rechecks.has(`${home}:${thread.id}`)) {
            this.pending.set(`${home}:${thread.id}`, record);
          }
          this.events.delete(`${home}:${thread.id}`);
        }
        for (const [id, record] of records) {
          if (!ids.has(id)) records.set(id, { ...record, available: false });
        }
        publishCodexArchiveRecords(home, records);
      } catch (error) {
        failures.add(home);
        console.warn(`[archive] ${home}: ${error.message}`);
      }
      this.#applyEvents(home);
      publishCodexArchiveRecords(home, this.records.get(home));
    }
    this.#save();
    return failures;
  }

  async #flush() {
    if (!this.sync || !this.pending.size) return;
    const observations = [...this.pending.values()].filter((record) => {
      try { return this.lookup(record.id)?.available === true; } catch { return false; }
    });
    if (!observations.length) return;
    const result = await this.sync(observations);
    const acknowledged = result?.acknowledged
      ? observations.filter((record) => result.acknowledged.includes(`${record.home}:${record.id}`))
      : observations;
    for (const conflict of result?.conflicts || []) {
      this.version = Math.max(this.version, conflict.version || 0);
      const record = this.records.get(conflict.home)?.get(conflict.id);
      if (record) record.reobserve = true;
    }
    for (const record of acknowledged) {
      this.pending.delete(`${record.home}:${record.id}`);
      this.rechecks.delete(`${record.home}:${record.id}`);
    }
    this.#save();
  }

  refresh() {
    return this.#run(async () => {
      if (this.stopped) return;
      await this.#probe();
      await this.#refresh();
      await this.#flush();
    });
  }

  #ancestors(record, records = this.records.get(record.home)) {
    const result = [];
    const seen = new Set();
    while (record) {
      if (seen.has(record.id)) throw archiveError('archive_state_unknown', 'Session ancestry is inconsistent.');
      seen.add(record.id);
      result.push(record);
      if (record.parentThreadId && !records.has(record.parentThreadId)) {
        throw archiveError('archive_state_unknown', 'Unable to verify the parent session.');
      }
      record = record.parentThreadId ? records.get(record.parentThreadId) : null;
    }
    return result;
  }

  #tree(record) {
    try {
      const records = this.readTree(record.home, this.records.get(record.home));
      return [...records.values()].filter((candidate) => (
        this.#ancestors(candidate, records).some((ancestor) => ancestor.id === record.id)
      ));
    } catch (error) {
      throw archiveError('archive_state_unknown', `Unable to verify the complete session tree: ${error.message}`);
    }
  }

  #checkUnlistedWork() {
    for (const id of new Set([...this.pendingSends.keys(), ...this.busySessionIds()])) {
      if (!this.lookup(id)?.available) {
        throw archiveError('session_active', 'Queued or active work has unverified session ancestry.');
      }
    }
  }

  async withWritable(id, operation) {
    if (!this.enabled) return operation();
    return this.#run(async () => {
      await this.#probe();
      if (this.protocolState === 'unknown') {
        throw archiveError('archive_state_unknown', 'Unable to verify the Codex protocol. Retry when Codex is available.');
      }
      if (!this.supported) {
        const cached = this.lookup(id);
        if (cached && this.#ancestors(cached).some((r) => r.archiveState === 'archived')) {
          throw archiveError('session_archived', 'Restore this session before continuing.');
        }
        return operation();
      }
      const failures = await this.#refresh();
      const record = this.lookup(id);
      if (!record?.available || failures.has(record.home)) {
        throw archiveError('archive_state_unknown', 'Unable to verify the session archive state. Retry when Codex is available.');
      }
      const ancestors = this.#ancestors(record);
      if (ancestors.some((ancestor) => !ancestor.available)) {
        throw archiveError('archive_state_unknown', 'Unable to verify the parent session archive state.');
      }
      if (ancestors.some((r) => r.archiveState === 'archived')) {
        throw archiveError('session_archived', 'Restore this session before continuing.');
      }
      return operation(record);
    });
  }

  setArchived(id, archived, options = {}) {
    return this.#run(async () => {
      let nativeApplied = false;
      try {
        await this.#probe();
        if (this.protocolState === 'unknown') throw archiveError('archive_state_unknown', 'Unable to verify the Codex protocol.');
        if (!this.supported) throw archiveError('archive_unsupported', 'Update Codex and the Bridge to enable archiving.');
        const failures = await this.#refresh();
        const record = this.lookup(id);
        if (!record?.available || failures.has(record.home)) throw archiveError('archive_state_unknown', 'Unable to verify the native session.');
        if (options.cwd && path.resolve(options.cwd) !== path.resolve(record.cwd)) {
          throw archiveError('archive_project_mismatch', 'Session belongs to another project.');
        }
        const target = archived ? 'archived' : 'unarchived';
        const affected = archived ? this.#tree(record) : [record];
        if (record.archiveState === target) {
          nativeApplied = true;
          return await this.#confirmedResult(record, affected, target);
        }
        const client = await this.#client(record.home);
        this.#checkUnlistedWork();
        for (const child of affected) {
          this.lookup(child.id);
          if (this.isBusy(child.id) || this.pendingSends.has(child.id)) {
            throw archiveError('session_active', 'A session or subagent is still active or has queued work.');
          }
          if (!child.available) throw archiveError('archive_state_unknown', 'A descendant is missing from the native catalog.');
          const { thread } = await client.request('thread/read', { threadId: child.id, includeTurns: false });
          if (!thread || !['idle', 'notLoaded'].includes(thread.status?.type)) {
            throw archiveError('session_active', 'A session or subagent is active or its state cannot be verified.');
          }
          const writer = await this.writer(child.id, record.home, client, thread);
          if (!writer?.verified || writer.occupied) {
            throw archiveError('archive_writer_busy', 'An external Codex writer is present or cannot be checked. Close it before archiving.');
          }
        }
        if (affected.some((child) => this.isBusy(child.id) || this.pendingSends.has(child.id))) {
          throw archiveError('session_active', 'A session or subagent has queued work.');
        }
        this.#checkUnlistedWork();
        for (const child of affected) this.rechecks.add(`${child.home}:${child.id}`);
        this.#save();
        let requestError;
        try {
          await client.request(archived ? 'thread/archive' : 'thread/unarchive', { threadId: id });
          nativeApplied = true;
        } catch (error) {
          requestError = error;
        }
        const refreshFailures = await this.#refresh();
        const actual = this.lookup(id);
        if (refreshFailures.has(record.home) || actual?.archiveState !== target) {
          throw requestError || archiveError('archive_verification_pending', 'Native result is not yet confirmed. Refresh before retrying.');
        }
        nativeApplied = true;
        return await this.#confirmedResult(record, affected, target);
      } catch (error) {
        return {
          sessionId: `codex:${id}`, ok: false, nativeApplied,
          errorCode: nativeApplied ? 'archive_sync_pending' : (error.code || 'archive_failed'),
          error: nativeApplied ? 'Native operation completed; synchronization is pending.' : error.message,
        };
      }
    });
  }

  async #confirmedResult(record, affected, target) {
    const partial = target === 'archived'
      ? affected.filter((child) => this.lookup(child.id)?.archiveState !== target).map((child) => `codex:${child.id}`)
      : [];
    await this.#flush();
    if (affected.some((child) => !this.lookup(child.id)?.available
      || this.pending.has(`${child.home}:${child.id}`) || this.rechecks.has(`${child.home}:${child.id}`))) {
      throw new Error('Archive persistence is pending.');
    }
    return { sessionId: `codex:${record.id}`, ok: true, archiveState: target, ...(partial.length ? { partial } : {}) };
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.tail;
    await Promise.allSettled([...this.clients.values()].map((client) => client.stop()));
    this.clients.clear();
  }
}

export const codexArchives = new CodexArchive();
