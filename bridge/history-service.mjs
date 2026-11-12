// `history` and `threads` RPCs for the v2 Session view. The session index (main thread) says which
// file a Session is; files are read in the history worker so long reads never block live streaming.
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { parseClaudeSubagentSessionId } from './claude-subagent.mjs';
import { sessionIndex } from './session-index.mjs';
import { runtimeDescriptor, runtimeModules, storageSessionId } from './session-identity.mjs';

const WARM_RECENT = 10;
const WARM_MAX = 20;

// Runs page work in a worker, started on first use and unref'd while idle.
function workerPages() {
  let worker = null;
  let sequence = 0;
  const pending = new Map();
  const call = (op, target, params) => {
    if (!worker) {
      const current = worker = new Worker(new URL('./history-worker.mjs', import.meta.url), { workerData: { runtimeModules: runtimeModules() } });
      const fail = (error) => {
        if (worker !== current) return;
        worker = null;
        for (const request of pending.values()) request.reject(error);
        pending.clear();
      };
      current.on('error', fail);
      current.on('exit', () => fail(new Error('History reader stopped.')));
      current.on('message', ({ id, result, error }) => {
        const request = pending.get(id);
        if (!request) return;
        pending.delete(id);
        if (error) request.reject(new Error(error));
        else request.resolve(result);
        if (!pending.size) current.unref();
      });
    }
    worker.ref();
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, op, target, params });
    });
  };
  return { history: (target, params) => call('history', target, params), warm: (target) => call('warm', target),
    children: (target) => call('children', target) };
}

export class HistoryService {
  constructor({ index, pages } = {}) {
    this.index = index;
    this.pages = pages || workerPages();
  }

  // { file, runtime, nativeSessionId, status } for a root Session, a Claude subagent or a Codex child.
  resolve(sessionId) {
    const { catalog } = this.index.snapshot();
    const row = catalog.roots.find((root) => root.sessionId === sessionId);
    if (row) return { file: row.rec.file, runtime: row.rec.runtime, nativeSessionId: row.rec.id, status: row.status };
    const statusOf = (id) => this.index.statuses.get(id) || 'completed';
    const sub = parseClaudeSubagentSessionId(sessionId);
    if (sub) {
      const root = catalog.roots.find((r) => r.rec.runtime === 'claude' && r.rec.id === sub.parentSessionId);
      const file = root && path.join(root.rec.dir, sub.parentSessionId, 'subagents', `${sub.agentId}.jsonl`);
      if (file && fs.existsSync(file)) return { file, runtime: 'claude', nativeSessionId: sessionId, status: statusOf(sessionId) };
      return null;
    }
    for (const rec of this.index.records.values()) {
      if (rec.runtime !== 'claude' && storageSessionId(rec.runtime, rec.id) === sessionId) {
        return { file: rec.file, runtime: rec.runtime, nativeSessionId: rec.id, status: statusOf(sessionId) };
      }
    }
    return null;
  }

  async history(params = {}) {
    await this.index.readyPromise;
    const target = this.resolve(String(params.sessionId || ''));
    if (!target) throw new Error('unknown_session');
    const { status, ...file } = target;
    // The root's subagent count: the App asks for `threads` only when there are some.
    const rootId = String(params.rootSessionId || params.sessionId || '');
    const root = this.index.snapshot().catalog.roots.find((row) => row.sessionId === rootId);
    const page = await this.pages.history(file, params);
    // A Session Baton started whose transcript is still empty (a forked Skill): the prompt it sent.
    const sentPrompt = status === 'running' && !page.messages.length && !params.after && this.index.sentPrompts?.get(target.nativeSessionId);
    return { ...page, status, ...(sentPrompt ? { sentPrompt } : {}), ...(root ? { agentCount: root.agentCount } : {}) };
  }

  // The thread list: the root, then its subagents depth-first, newest first.
  async threads(params = {}) {
    await this.index.readyPromise;
    const sessionId = String(params.sessionId || '');
    const { catalog } = this.index.snapshot();
    const row = catalog.roots.find((root) => root.sessionId === sessionId);
    if (!row) return { rootSessionId: sessionId, threads: [] };
    const rec = row.rec;
    const items = [{ sessionId, preview: row.preview, status: row.status, lastActive: new Date(rec.ms).toISOString(), size: rec.size,
      agentName: row.agent?.agentName || '', runtime: rec.runtime, nativeSessionId: rec.id, canSend: !rec.view?.readOnly }];
    const source = runtimeDescriptor(rec.runtime)?.catalog;
    if (row.agentCount && source) {
      // A registered runtime's children are catalog records already.
      for (const child of row.children) {
        const childId = storageSessionId(rec.runtime, child.id);
        items.push({ sessionId: childId, preview: child.view.preview, lastActive: new Date(child.ms).toISOString(), size: child.size,
          status: this.index.statuses.get(childId) || source.status(child, this.index.running?.[rec.runtime], Date.now()),
          agentName: child.view.agentName, runtime: rec.runtime, nativeSessionId: child.id, threadKind: 'subagent',
          parentSessionId: storageSessionId(rec.runtime, child.view.parent) });
      }
    } else if (row.agentCount) {
      const codex = rec.runtime === 'codex' ? row.children.map((child) => ({ file: child.file, id: child.id,
        threadName: this.index.threadNames.get(child.home)?.names.get(child.id) || '' })) : [];
      const children = await this.pages.children({ runtime: rec.runtime, dir: rec.dir, id: rec.id, project: row.project,
        status: row.own || row.status, codex });
      for (const child of children) {
        const childId = storageSessionId(child.runtime, child.nativeSessionId);
        items.push({ ...child, sessionId: childId, status: this.index.statuses.get(childId) || child.status });
      }
    }
    return { rootSessionId: sessionId, threads: orderThreads(items, sessionId).map(threadFields) };
  }

  // Index and read the latest page of the Sessions most likely opened next, once per run (from the
  // first home request, so a Bridge no v2 App talks to never starts the worker).
  warm() {
    this.warming ||= this.warmNow().catch((error) => console.error(`[history] warm failed: ${error.message}`));
    return this.warming;
  }

  async warmNow() {
    await this.index.readyPromise;
    const { catalog } = this.index.snapshot();
    const active = catalog.roots.filter((row) => row.status === 'running' || row.status === 'needs_input');
    const picked = [...new Set([...active, ...catalog.roots.slice(0, WARM_RECENT)])].slice(0, WARM_MAX);
    for (const row of picked) {
      try {
        await this.pages.warm({ file: row.rec.file, runtime: row.rec.runtime, nativeSessionId: row.rec.id });
      } catch {}
    }
  }
}

function threadFields(item) {
  const thread = {
    sessionId: item.sessionId,
    preview: item.preview || '',
    status: item.status || 'completed',
    lastActive: item.lastActive || '',
    size: item.size || 0,
    agentName: item.agentName || '',
    agentRole: item.agentRole || '',
    runtime: item.runtime || 'claude',
    nativeSessionId: item.nativeSessionId || item.sessionId,
    threadKind: item.threadKind || 'main',
    canSend: item.canSend ?? true,
  };
  if (item.parentSessionId) {
    Object.assign(thread, { parentSessionId: item.parentSessionId, agentPath: item.agentPath || '',
      agentDepth: item.agentDepth || 1 });
  }
  return thread;
}

function orderThreads(items, rootId) {
  const byParent = new Map();
  for (const item of items) {
    if (item.threadKind !== 'subagent' || !item.parentSessionId) continue;
    if (!byParent.has(item.parentSessionId)) byParent.set(item.parentSessionId, []);
    byParent.get(item.parentSessionId).push(item);
  }
  const ordered = items.filter((item) => item.sessionId === rootId);
  const seen = new Set([rootId]);
  const visit = (parentId) => {
    const children = (byParent.get(parentId) || []).sort((a, b) => (a.lastActive < b.lastActive ? 1 : a.lastActive > b.lastActive ? -1
      : a.sessionId < b.sessionId ? 1 : a.sessionId > b.sessionId ? -1 : 0));
    for (const child of children) {
      if (seen.has(child.sessionId)) continue;
      seen.add(child.sessionId);
      ordered.push(child);
      visit(child.sessionId);
    }
  };
  visit(rootId);
  return ordered;
}

export const historyService = new HistoryService({ index: sessionIndex });
