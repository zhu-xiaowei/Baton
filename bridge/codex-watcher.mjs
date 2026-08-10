import fs from 'fs';
import path from 'path';
import parcelWatcher from '@parcel/watcher';
import {
  CODEX_RECENT_FILE_WATCH_LIMIT,
  CODEX_STATUS_RECHECK_MS,
  CODEX_STATUS_STALE_MS,
  CODEX_WATCH_RESCAN_MS,
} from './config.mjs';
import { syncCodexMessages } from './codex-extract.mjs';
import {
  codexSessionIdFromPath,
  getCodexRunningInfo,
  scanCodexRollout,
} from './codex-session.mjs';
import { countJsonlLines, synced } from './extract.mjs';
import { postRequired } from './http.mjs';
import { deliverRealtimeMessages } from './realtime-delivery.mjs';
import { resolveCodexHomes } from './runtime-capabilities.mjs';
import { storageSessionId } from './session-identity.mjs';
import {
  knownProjects,
  lastKnownStatus,
  recentSessions,
  reconcile,
} from './sync.mjs';
import { defineRuntimeWatcher } from './watcher-adapter.mjs';

function walkJsonl(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(fullPath);
    }
  }
  return files;
}

function metadataSignature(session) {
  return JSON.stringify([
    session.project,
    session.preview,
    session.model,
    session.modelProvider,
    session.clientSource,
    session.cliVersion,
  ]);
}

function insideRoot(filePath, root) {
  const relative = path.relative(root, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalPath(filePath) {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

export class CodexWatcher {
  constructor(config, options = {}) {
    this.config = config;
    this.homes = options.codexHomes || resolveCodexHomes();
    this.roots = this.homes.map((home) => canonicalPath(path.join(home, 'sessions')));
    this.initialIds = new Set((options.initialSessions || [])
      .filter((session) => session.runtime === 'codex')
      .map((session) => session.nativeSessionId || session.id));
    this.initialCatchupIds = new Set((options.initialSessions || [])
      .filter((session) => session.runtime === 'codex')
      .filter((session) => session.status !== 'completed'
        || Date.parse(session.lastActive) >= Date.now() - 86400_000)
      .map((session) => session.nativeSessionId || session.id));
    this.watermarks = options.watermarks || synced;
    this.recent = options.recentSessions || recentSessions;
    this.statuses = options.lastKnownStatus || lastKnownStatus;
    this.projects = options.knownProjects || knownProjects;
    this.postFn = options.postFn || postRequired;
    this.reconcileFn = options.reconcileFn || reconcile;
    this.deliverFn = options.deliverFn || deliverRealtimeMessages;
    this.scanRollout = options.scanRollout || scanCodexRollout;
    this.runningInfoFn = options.runningInfoFn || getCodexRunningInfo;
    this.subscribeFn = options.subscribeFn
      || ((root, callback) => parcelWatcher.subscribe(root, callback));
    this.watchFileFn = options.watchFileFn || ((filePath, callback) => fs.watch(filePath, callback));
    this.recentFileWatchLimit = options.recentFileWatchLimit
      ?? CODEX_RECENT_FILE_WATCH_LIMIT;
    this.rescanMs = options.rescanMs ?? CODEX_WATCH_RESCAN_MS;
    this.retryMs = options.retryMs || 1000;
    this.watchRetryMs = options.watchRetryMs || 2000;
    this.statusRecheckMs = options.statusRecheckMs || CODEX_STATUS_RECHECK_MS;
    this.fileStats = new Map();
    this.sessionPaths = new Map();
    this.busy = new Map();
    this.retryTimers = new Map();
    this.watchRetryTimers = new Map();
    this.statusTimers = new Map();
    this.watchHandles = new Map();
    this.watchPromises = new Map();
    this.fileWatchers = new Map();
    this.desiredFileWatchers = new Set();
    this.fileWatchRetryTimers = new Map();
    this.metadataSignatures = new Map((options.initialSessions || [])
      .filter((session) => session.runtime === 'codex')
      .map((session) => [
        storageSessionId('codex', session.nativeSessionId || session.id),
        metadataSignature(session),
      ]));
    this.timers = [];
    this.stopped = false;
    this.readyPromise = Promise.resolve();
  }

  start() {
    this.stopped = false;
    console.log(`[watcher] Codex: ${this.roots.join(', ')}`);
    this.readyPromise = this.scanNow({ initial: true })
      .then(() => this.ensureWatchers())
      // Close the small gap between the initial scan and native subscription.
      .then(() => this.scanNow())
      .then(() => {
        console.log(
          `[watcher] Codex ready: ${this.watchHandles.size} roots, `
          + `${this.fileWatchers.size} active/recent rollouts`,
        );
      })
      .catch((error) => {
        console.error(`[watcher] Codex initial scan failed: ${error.message}`);
      });
    const safety = setInterval(() => {
      this.scanNow()
        .catch((error) => console.error(`[watcher] Codex rescan failed: ${error.message}`))
        .finally(() => this.ensureWatchers().catch(() => {}));
    }, this.rescanMs);
    safety.unref();
    this.timers.push(safety);
    return this;
  }

  stop() {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    for (const timer of this.watchRetryTimers.values()) clearTimeout(timer);
    for (const timer of this.fileWatchRetryTimers.values()) clearTimeout(timer);
    for (const timer of this.statusTimers.values()) clearTimeout(timer);
    for (const root of this.watchHandles.keys()) this.closeWatcher(root);
    for (const filePath of this.fileWatchers.keys()) this.closeFileWatcher(filePath);
    this.timers = [];
    this.retryTimers.clear();
    this.watchRetryTimers.clear();
    this.fileWatchRetryTimers.clear();
    this.statusTimers.clear();
    this.watchHandles.clear();
    this.fileWatchers.clear();
    this.desiredFileWatchers.clear();
  }

  async ensureWatchers() {
    await Promise.all(this.roots.map((root) => this.ensureWatcher(root)));
  }

  async ensureWatcher(root) {
    if (this.watchHandles.has(root)) return true;
    if (this.watchPromises.has(root)) return this.watchPromises.get(root);
    const pending = this.openWatcher(root);
    this.watchPromises.set(root, pending);
    try {
      return await pending;
    } finally {
      this.watchPromises.delete(root);
    }
  }

  async openWatcher(root) {
    try {
      if (!fs.statSync(root).isDirectory()) throw new Error('not a directory');
    } catch {
      this.scheduleWatcherRetry(root);
      return false;
    }
    try {
      const watcher = await this.subscribeFn(root, (error, events = []) => {
        if (error) {
          console.error(`[watcher] Codex subscription error for ${root}: ${error.message}`);
          this.closeWatcher(root);
          this.scheduleWatcherRetry(root);
          return;
        }
        let needsScan = false;
        for (const event of events) {
          const changedPath = canonicalPath(event.path);
          if (!insideRoot(changedPath, root)) continue;
          if (!changedPath.endsWith('.jsonl')) {
            needsScan = true;
            continue;
          }
          if (event.type === 'delete') {
            this.forgetPath(changedPath);
            continue;
          }
          this.queueChangedFile(changedPath);
        }
        if (needsScan) this.scanNow({ roots: [root] }).catch(() => {});
      });
      if (this.stopped) {
        await watcher.unsubscribe();
        return false;
      }
      this.watchHandles.set(root, watcher);
      const retry = this.watchRetryTimers.get(root);
      if (retry) clearTimeout(retry);
      this.watchRetryTimers.delete(root);
      return true;
    } catch (error) {
      console.error(`[watcher] Codex subscribe failed for ${root}: ${error.message}`);
      this.scheduleWatcherRetry(root);
      return false;
    }
  }

  closeWatcher(root) {
    const watcher = this.watchHandles.get(root);
    this.watchHandles.delete(root);
    if (watcher) Promise.resolve(watcher.unsubscribe()).catch(() => {});
  }

  scheduleWatcherRetry(root) {
    if (this.stopped || this.watchRetryTimers.has(root)) return;
    const timer = setTimeout(() => {
      this.watchRetryTimers.delete(root);
      this.ensureWatcher(root).then((ready) => {
        if (ready) this.scanNow({ roots: [root] }).catch((error) => {
          console.error(`[watcher] Codex recovery scan failed: ${error.message}`);
        });
      });
    }, this.watchRetryMs);
    timer.unref();
    this.watchRetryTimers.set(root, timer);
  }

  async scanNow(options = {}) {
    const roots = options.roots || this.roots;
    const found = new Set();
    for (const root of roots) {
      for (const filePath of walkJsonl(root)) {
        found.add(filePath);
        let stat;
        try {
          stat = fs.statSync(filePath);
        } catch {
          continue;
        }
        const previous = this.fileStats.get(filePath);
        this.rememberPath(filePath, stat);
        if (previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) continue;

        const nativeSessionId = codexSessionIdFromPath(filePath);
        if (!nativeSessionId) continue;
        if (options.initial && this.initialIds.has(nativeSessionId)) {
          const key = storageSessionId('codex', nativeSessionId);
          if (!this.watermarks.has(key) && !this.initialCatchupIds.has(nativeSessionId)) {
            continue;
          }
          if (this.watermarks.has(key) && countJsonlLines(filePath) <= this.watermarks.get(key)) {
            continue;
          }
        }
        this.queueFile(filePath);
      }
    }

    for (const filePath of Array.from(this.fileStats.keys())) {
      if (!roots.some((root) => insideRoot(filePath, root)) || found.has(filePath)) continue;
      this.forgetPath(filePath, { refresh: false });
    }
    this.refreshFileWatchers();
    await this.flush();
  }

  rememberPath(filePath, stat) {
    this.fileStats.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs });
    const nativeSessionId = codexSessionIdFromPath(filePath);
    if (!nativeSessionId) return;
    const paths = this.sessionPaths.get(nativeSessionId) || new Set();
    paths.add(filePath);
    this.sessionPaths.set(nativeSessionId, paths);
  }

  forgetPath(filePath, options = {}) {
    this.fileStats.delete(filePath);
    const nativeSessionId = codexSessionIdFromPath(filePath);
    const paths = this.sessionPaths.get(nativeSessionId);
    if (paths) {
      paths.delete(filePath);
      if (!paths.size) this.sessionPaths.delete(nativeSessionId);
    }
    this.desiredFileWatchers.delete(filePath);
    this.closeFileWatcher(filePath);
    if (options.refresh !== false) this.refreshFileWatchers();
  }

  desiredFileWatchPaths() {
    const running = [];
    const recent = [];
    for (const [nativeSessionId] of this.sessionPaths) {
      const filePath = this.preferredPath(nativeSessionId);
      if (!filePath) continue;
      const candidate = {
        filePath,
        mtimeMs: this.fileStats.get(filePath)?.mtimeMs ?? 0,
      };
      const sessionId = storageSessionId('codex', nativeSessionId);
      if (this.statuses.get(sessionId) === 'running') running.push(candidate);
      else recent.push(candidate);
    }
    recent.sort((left, right) => right.mtimeMs - left.mtimeMs);
    return new Set([
      ...running.map((candidate) => candidate.filePath),
      ...recent.slice(0, this.recentFileWatchLimit).map((candidate) => candidate.filePath),
    ]);
  }

  refreshFileWatchers() {
    if (this.stopped) return;
    const desired = this.desiredFileWatchPaths();
    this.desiredFileWatchers = desired;
    for (const filePath of this.fileWatchers.keys()) {
      if (!desired.has(filePath)) this.closeFileWatcher(filePath);
    }
    for (const filePath of desired) this.ensureFileWatcher(filePath);
  }

  ensureFileWatcher(filePath) {
    if (this.stopped || this.fileWatchers.has(filePath)) return false;
    let before;
    try {
      before = fs.statSync(filePath);
      if (!before.isFile()) return false;
    } catch {
      return false;
    }

    try {
      const watcher = this.watchFileFn(filePath, (eventType) => {
        if (eventType === 'rename') {
          this.closeFileWatcher(filePath);
          const root = this.roots.find((candidate) => insideRoot(filePath, candidate));
          if (root) this.scanNow({ roots: [root] }).catch(() => {});
          return;
        }
        this.queueChangedFile(filePath);
      });
      watcher.on?.('error', (error) => {
        console.error(`[watcher] Codex file watch failed for ${filePath}: ${error.message}`);
        this.closeFileWatcher(filePath);
        this.scheduleFileWatcherRetry(filePath);
      });
      this.fileWatchers.set(filePath, watcher);
      const retry = this.fileWatchRetryTimers.get(filePath);
      if (retry) clearTimeout(retry);
      this.fileWatchRetryTimers.delete(filePath);

      try {
        const after = fs.statSync(filePath);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
          this.queueChangedFile(filePath);
        }
      } catch {
        this.closeFileWatcher(filePath);
        this.scheduleFileWatcherRetry(filePath);
      }
      return true;
    } catch (error) {
      console.error(`[watcher] Codex file watch failed for ${filePath}: ${error.message}`);
      this.scheduleFileWatcherRetry(filePath);
      return false;
    }
  }

  closeFileWatcher(filePath) {
    const watcher = this.fileWatchers.get(filePath);
    this.fileWatchers.delete(filePath);
    try {
      watcher?.close();
    } catch {}
    if (this.stopped || !this.desiredFileWatchers.has(filePath)) {
      const retry = this.fileWatchRetryTimers.get(filePath);
      if (retry) clearTimeout(retry);
      this.fileWatchRetryTimers.delete(filePath);
    }
  }

  scheduleFileWatcherRetry(filePath) {
    if (this.stopped || this.fileWatchRetryTimers.has(filePath)) return;
    const timer = setTimeout(() => {
      this.fileWatchRetryTimers.delete(filePath);
      if (!this.desiredFileWatchers.has(filePath)) return;
      this.ensureFileWatcher(filePath);
      this.queueChangedFile(filePath);
    }, this.watchRetryMs);
    timer.unref();
    this.fileWatchRetryTimers.set(filePath, timer);
  }

  preferredPath(nativeSessionId) {
    let best = null;
    let bestMtime = -1;
    for (const filePath of this.sessionPaths.get(nativeSessionId) || []) {
      const mtime = this.fileStats.get(filePath)?.mtimeMs ?? -1;
      if (mtime > bestMtime) {
        best = filePath;
        bestMtime = mtime;
      }
    }
    return best;
  }

  queueChangedFile(filePath) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      this.forgetPath(filePath);
      return Promise.resolve();
    }
    const previous = this.fileStats.get(filePath);
    const alreadyWatched = this.fileWatchers.has(filePath);
    this.rememberPath(filePath, stat);
    if (!alreadyWatched) this.refreshFileWatchers();
    if (previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) {
      return Promise.resolve();
    }
    return this.queueFile(filePath);
  }

  queueFile(filePath, options = {}) {
    const nativeSessionId = codexSessionIdFromPath(filePath);
    if (!nativeSessionId) return Promise.resolve();
    try {
      const stat = fs.statSync(filePath);
      this.rememberPath(filePath, stat);
    } catch {
      return Promise.resolve();
    }

    const active = this.busy.get(nativeSessionId);
    if (active) {
      active.pending = true;
      active.forceStatus ||= !!options.forceStatus;
      return active.promise;
    }

    const state = { pending: true, forceStatus: !!options.forceStatus, promise: null };
    this.busy.set(nativeSessionId, state);
    state.promise = Promise.resolve().then(async () => {
      do {
        state.pending = false;
        const forceStatus = state.forceStatus;
        state.forceStatus = false;
        const currentPath = this.preferredPath(nativeSessionId);
        if (!currentPath) break;
        try {
          const result = await this.processFile(currentPath, { forceStatus });
          state.pending ||= result.fileChanged;
          this.clearRetry(nativeSessionId);
        } catch (error) {
          console.error(`[watcher] Codex ${nativeSessionId.slice(-8)}: ${error.message}`);
          this.scheduleRetry(nativeSessionId, currentPath);
          break;
        }
      } while (state.pending);
    }).finally(() => {
      this.busy.delete(nativeSessionId);
    });
    return state.promise;
  }

  async flush() {
    while (this.busy.size) {
      await Promise.all(Array.from(this.busy.values(), (state) => state.promise));
    }
  }

  async processFile(filePath, options = {}) {
    const nativeSessionId = codexSessionIdFromPath(filePath);
    const sessionId = storageSessionId('codex', nativeSessionId);
    const processedStat = fs.statSync(filePath);
    this.rememberPath(filePath, processedStat);
    const extracted = await syncCodexMessages(filePath, nativeSessionId, sessionId, {
      watermarks: this.watermarks,
      uploader: (id, messages, identity) => this.deliverFn(id, messages, identity),
    });

    const needsSessionScan = options.forceStatus
      || extracted.needsSessionScan
      || !this.metadataSignatures.has(sessionId);
    if (needsSessionScan) {
      const result = this.scanRollout(filePath, {
        nativeSessionId,
        ...(options.forceStatus ? { runningInfo: this.runningInfoFn() } : {}),
      });
      if (result.session) {
        await this.syncMetadata(result.session);
        this.scheduleStatusRecheck(result.session, filePath);
      }
    } else if (this.statuses.get(sessionId) === 'running') {
      this.scheduleStatusRecheck({ nativeSessionId, status: 'running' }, filePath);
    }

    let fileChanged = false;
    try {
      const currentStat = fs.statSync(filePath);
      fileChanged = currentStat.size !== processedStat.size
        || currentStat.mtimeMs !== processedStat.mtimeMs;
    } catch {}
    return { ...extracted, fileChanged };
  }

  async syncMetadata(session) {
    const sessionId = storageSessionId('codex', session.nativeSessionId);
    const previousStatus = this.statuses.get(sessionId);
    const isNew = !this.recent.has(sessionId);
    const signature = metadataSignature(session);
    const metadataChanged = this.metadataSignatures.get(sessionId) !== signature;
    const statusChanged = previousStatus !== session.status;
    if (!isNew && !metadataChanged && !statusChanged) return;

    const projectWasKnown = this.projects.has(session.project);
    const statusDelta = isNew || statusChanged ? {
      deviceName: this.config.deviceName,
      projectHash: session.project,
      projectName: session.projectName,
      from: isNew ? 'new' : (previousStatus || 'completed'),
      to: session.status,
      lastActive: session.lastActive,
    } : null;
    const { _filePath, _lineCount, ...publicSession } = session;
    await this.postFn('/api/bridge/sync-sessions', {
      deviceName: this.config.deviceName,
      os: process.platform,
      sessions: [publicSession],
      ...(statusDelta ? { statusDelta } : {}),
    });

    this.statuses.set(sessionId, session.status);
    this.recent.add(sessionId);
    this.projects.add(session.project);
    this.metadataSignatures.set(sessionId, signature);
    this.refreshFileWatchers();
    if (!projectWasKnown) await this.reconcileFn(this.config);
  }

  scheduleRetry(nativeSessionId, filePath) {
    if (this.retryTimers.has(nativeSessionId)) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(nativeSessionId);
      this.queueFile(filePath);
    }, this.retryMs);
    timer.unref();
    this.retryTimers.set(nativeSessionId, timer);
  }

  clearRetry(nativeSessionId) {
    const timer = this.retryTimers.get(nativeSessionId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(nativeSessionId);
  }

  scheduleStatusRecheck(session, filePath) {
    const nativeSessionId = session.nativeSessionId;
    const existing = this.statusTimers.get(nativeSessionId);
    if (existing) clearTimeout(existing);
    this.statusTimers.delete(nativeSessionId);
    if (session.status !== 'running') return;

    const mtimeMs = this.fileStats.get(filePath)?.mtimeMs || Date.now();
    const staleAt = mtimeMs + CODEX_STATUS_STALE_MS + 1000;
    const delay = staleAt > Date.now() ? staleAt - Date.now() : this.statusRecheckMs;
    const timer = setTimeout(() => {
      this.statusTimers.delete(nativeSessionId);
      this.queueFile(filePath, { forceStatus: true });
    }, delay);
    timer.unref();
    this.statusTimers.set(nativeSessionId, timer);
  }
}

export function startCodexWatcher(config, context = {}) {
  return new CodexWatcher(config, context).start();
}

export const codexWatcherAdapter = defineRuntimeWatcher({
  runtime: 'codex',
  start: startCodexWatcher,
});
