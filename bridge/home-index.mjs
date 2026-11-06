// On-demand home answer for v2 (App asks the Bridge directly, nothing read from DDB).
// The index only stats JSONL files (mtime = lastActive) and reads each Codex header; previews,
// validity and subagents are parsed once per file version and kept in memory. Changes only mark
// the answer dirty; the answer is rebuilt when a request arrives.
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { CLAUDE_PROJECTS, CODEX_STATUS_STALE_MS } from './config.mjs';
import {
  cachedDaemonSessions, getRunningInfo, getSessionMetadata, getSessionStatus,
  normalizeProjectHash, readClaudeFirstPrompts, readableProjectName,
} from './session.mjs';
import { codexSessionIdFromPath, getCodexRunningInfo, readCodexThreadNames, scanCodexRollout } from './codex-session.mjs';
import { discoverClaudeSubagents } from './claude-subagent.mjs';
import { projectHashFromCwd, storageSessionId } from './session-identity.mjs';
import { resolveCodexHomes } from './runtime-capabilities.mjs';

const PROJECT_LIMIT = 15;
const SESSIONS_PER_PROJECT = 5;
const NEEDS_INPUT_WINDOW_MS = 7 * 86400_000;
const CLAUDE_FRESH_MS = 300_000;
const HEADER_BYTES = 8192;
const RUNNING_INFO_TTL_MS = 5000;

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

export class HomeIndex {
  constructor({ statuses, claudeRoot = CLAUDE_PROJECTS, codexHomes } = {}) {
    this.statuses = statuses || new Map();
    this.claudeRoot = claudeRoot;
    this.codexHomes = codexHomes;
    this.files = new Map();      // path → entry
    this.meta = new Map();       // path → { size, preview, codex?, invalid? }
    this.headers = new Map();    // Codex path → { project, parent }; a header never changes
    this.children = new Map();   // root path → { signature, list }
    this.history = null;
    this.threadNames = new Map();
    this.boot = randomUUID().slice(0, 8);
    this.revision = 0;
    this.running = null;
    this.names = new Map();
    this.answer = null;
    this.dirty = true;
    this.ready = false;
  }

  // ---------- index ----------
  addClaude(file, stat, target) {
    const dir = path.dirname(file);
    const id = path.basename(file, '.jsonl');
    target.set(file, { runtime: 'claude', id, file, dir, size: stat.size, mtimeMs: stat.mtimeMs,
      lastActive: stat.mtime.toISOString(), project: normalizeProjectHash(path.basename(dir)) });
  }

  addCodex(file, stat, home, target) {
    const id = codexSessionIdFromPath(file);
    if (!id) return;
    let header = this.headers.get(file);
    if (!header) {
      const fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(HEADER_BYTES);
      const length = fs.readSync(fd, buffer, 0, HEADER_BYTES, 0);
      fs.closeSync(fd);
      const head = buffer.subarray(0, length).toString();
      const cwd = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head);
      header = {
        project: cwd ? projectHashFromCwd(JSON.parse(`"${cwd[1]}"`), this.claudeRoot) : '',
        parent: /"(?:parent_thread_id|forked_from_id)":"([^"]+)"/.exec(head)?.[1] || '',
      };
      this.headers.set(file, header);
    }
    target.set(file, { runtime: 'codex', id, file, home, size: stat.size, mtimeMs: stat.mtimeMs,
      lastActive: stat.mtime.toISOString(), ...header });
  }

  indexFile(file, home, target = this.files) {
    let stat;
    try { stat = fs.statSync(file); } catch { stat = null; }
    if (!stat?.isFile() || !stat.size) {
      target.delete(file);
      this.meta.delete(file);
      this.headers.delete(file);
      return;
    }
    if (home) this.addCodex(file, stat, home, target);
    else this.addClaude(file, stat, target);
  }

  async build() {
    const found = [];
    let projects = [];
    try { projects = fs.readdirSync(this.claudeRoot); } catch {}
    for (const project of projects) {
      const dir = path.join(this.claudeRoot, project);
      let names = [];
      try { if (fs.statSync(dir).isDirectory()) names = fs.readdirSync(dir); } catch {}
      for (const name of names) {
        if (name.endsWith('.jsonl') && !name.startsWith('.')) found.push([path.join(dir, name)]);
      }
    }
    for (const home of this.codexHomes || resolveCodexHomes()) {
      const walk = (dir) => {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch {}
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push([full, home]);
        }
      };
      walk(path.join(home, 'sessions'));
    }
    // Requests keep using the previous index until the new one is complete.
    const next = new Map();
    for (let i = 0; i < found.length; i++) {
      this.indexFile(found[i][0], found[i][1], next);
      if (i % 200 === 199) await yieldToLoop();
    }
    this.files = next;
    this.markDirty();
  }

  // Called from the existing watchers with metadata they already parsed.
  noteClaude(file, metadata) {
    this.indexFile(file);
    const entry = this.files.get(file);
    if (entry && metadata) this.meta.set(file, { size: entry.size, preview: metadata.preview || '' });
    this.markDirty();
  }

  noteCodex(session) {
    const file = session?._filePath;
    if (!file) return;
    const home = this.codexHomeFor(file);
    if (!home) return;
    this.indexFile(file, home);
    const entry = this.files.get(file);
    if (entry) this.meta.set(file, { size: entry.size, preview: session.preview, codex: session });
    this.markDirty();
  }

  touch(file) {
    if (file.endsWith('.jsonl') && !file.includes(`${path.sep}subagents${path.sep}`)) {
      const home = this.codexHomeFor(file);
      this.indexFile(file, home || undefined);
    }
    this.markDirty();
  }

  codexHomeFor(file) {
    return (this.codexHomes || resolveCodexHomes()).find((home) => file.startsWith(path.join(home, 'sessions') + path.sep));
  }

  markDirty() {
    this.dirty = true;
  }

  // ---------- parsing ----------
  // A preview only changes with a new title or the first prompt, which the watchers report
  // through noteClaude/noteCodex; plain appends keep the cached parse. Files that shrank were
  // rewritten, and files without a preview yet are re-read as they grow.
  firstPrompts() {
    const file = path.join(path.dirname(this.claudeRoot), 'history.jsonl');
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch {}
    if (this.history?.mtime !== mtime) {
      let prompts = new Map();
      try { prompts = readClaudeFirstPrompts(file); } catch {}
      this.history = { mtime, prompts };
    }
    return this.history.prompts;
  }

  threadName(home, id) {
    if (!this.threadNames.has(home)) {
      let names = new Map();
      try { names = readCodexThreadNames(home); } catch {}
      this.threadNames.set(home, names);
    }
    return this.threadNames.get(home).get(id);
  }

  metadata(entry, ctx) {
    const cached = this.meta.get(entry.file);
    if (cached && (cached.size === entry.size || (entry.size > cached.size && cached.preview && !cached.invalid))) return cached;
    if (ctx.missing) {
      ctx.missing.push(entry);
      return null;
    }
    let value;
    if (entry.runtime === 'claude') {
      const meta = getSessionMetadata(entry.file, { firstPrompt: this.firstPrompts().get(entry.id) });
      value = { size: entry.size, preview: meta.preview || '' };
    } else {
      const scan = scanCodexRollout(entry.file, { runningInfo: ctx.codexRunning, nativeSessionId: entry.id,
        threadName: this.threadName(entry.home, entry.id) });
      value = { size: entry.size, preview: scan.session?.preview || '', codex: scan.session, invalid: !scan.session };
    }
    this.meta.set(entry.file, value);
    return value;
  }

  claudeChildren(entry, status, ctx) {
    const dir = path.join(entry.dir, entry.id, 'subagents');
    let names = [];
    try { names = fs.readdirSync(dir).filter((name) => name.startsWith('agent-') && name.endsWith('.jsonl')); } catch {}
    if (!names.length) return [];
    const signature = names.map((name) => {
      try { const st = fs.statSync(path.join(dir, name)); return `${name}:${st.size}:${st.mtimeMs}`; } catch { return name; }
    }).join('|') + `|${status}`;
    const cached = this.children.get(entry.file);
    if (cached?.signature === signature && Date.now() - cached.at < 15_000) return cached.list;
    const list = discoverClaudeSubagents(entry.dir, { nativeSessionId: entry.id, project: entry.project, status }, { now: ctx.now });
    this.children.set(entry.file, { signature, list, at: Date.now() });
    return list;
  }

  // ---------- answer ----------
  view(entry, ctx) {
    const key = entry.file;
    if (ctx.views.has(key)) return ctx.views.get(key);
    const meta = this.metadata(entry, ctx);
    let result = null;
    if (meta && !meta.invalid) {
      const sessionId = storageSessionId(entry.runtime, entry.id);
      const daemon = entry.runtime === 'claude' ? ctx.daemon.get(entry.id) : null;
      let status = this.statuses.get(sessionId);
      if (!status) {
        status = daemon ? daemon.status
          : entry.runtime === 'claude' ? (ctx.candidates.has(key) ? getSessionStatus(entry.id, entry.file, ctx.claudeRunning) : 'completed')
            : meta.codex.status;
      }
      let children;
      if (entry.runtime === 'claude') {
        children = this.claudeChildren(entry, status, ctx);
      } else {
        children = [];
        const queue = [...(ctx.childrenOf.get(entry.id) || [])];
        while (queue.length) {
          const child = queue.shift();
          const childMeta = this.metadata(child, { ...ctx, missing: null });
          if (childMeta?.codex) children.push(childMeta.codex);
          queue.push(...(ctx.childrenOf.get(child.id) || []));
        }
        children = children.filter((child) => child.threadKind === 'subagent');
      }
      const preview = meta.preview || (children.length ? 'New session' : '');
      if (preview) {
        const childStatus = (child) => this.statuses.get(storageSessionId(child.runtime, child.nativeSessionId)) || child.status;
        const running = children.filter((child) => childStatus(child) === 'running').length;
        const waiting = children.filter((child) => childStatus(child) === 'needs_input').length;
        result = {
          sessionId, preview, lastActive: entry.lastActive, agentCount: children.length, project: entry.project,
          status: status === 'needs_input' || waiting ? 'needs_input' : (status === 'running' || running ? 'running' : 'completed'),
          ...(daemon ? { isAgent: true, agentName: daemon.agentName || '', agentDetail: daemon.agentDetail } : {}),
        };
      }
    }
    ctx.views.set(key, result);
    return result;
  }

  compute({ collectMissing = false } = {}) {
    const now = Date.now();
    const roots = [];
    const childrenOf = new Map();
    for (const entry of this.files.values()) {
      if (entry.runtime === 'codex' && entry.parent) {
        if (!childrenOf.has(entry.parent)) childrenOf.set(entry.parent, []);
        childrenOf.get(entry.parent).push(entry);
      } else if (entry.project) {
        roots.push(entry);
      }
    }
    roots.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (!this.running || now - this.running.at > RUNNING_INFO_TTL_MS) {
      this.running = { at: now, claude: getRunningInfo(), codex: getCodexRunningInfo() };
    }
    const claudeRunning = this.running.claude;
    const codexRunning = this.running.codex;
    const daemon = cachedDaemonSessions();
    const liveIds = new Set([...claudeRunning.sessions, ...(claudeRunning.liveStatuses?.keys() || []), ...daemon.keys()]);
    const freshChild = (entry) => {
      if (entry.runtime === 'claude') {
        const dir = path.join(entry.dir, entry.id, 'subagents');
        let names = [];
        try { names = fs.readdirSync(dir); } catch {}
        return names.some((name) => { try { return now - fs.statSync(path.join(dir, name)).mtimeMs < 15_000; } catch { return false; } });
      }
      const queue = [...(childrenOf.get(entry.id) || [])];
      while (queue.length) {
        const child = queue.shift();
        if (codexRunning.sessions.has(child.id) || now - child.mtimeMs <= CODEX_STATUS_STALE_MS) return true;
        queue.push(...(childrenOf.get(child.id) || []));
      }
      return false;
    };
    const candidates = new Set();
    for (const entry of roots) {
      const sessionId = storageSessionId(entry.runtime, entry.id);
      const known = this.statuses.get(sessionId);
      const live = entry.runtime === 'claude'
        ? liveIds.has(entry.id) || (now - entry.mtimeMs <= CLAUDE_FRESH_MS && claudeRunning.projects.has(path.basename(entry.dir)))
        : codexRunning.sessions.has(entry.id) || now - entry.mtimeMs <= CODEX_STATUS_STALE_MS;
      if (known === 'running' || known === 'needs_input' || live || freshChild(entry)) candidates.add(entry.file);
    }
    const ctx = { now, childrenOf, claudeRunning, codexRunning, daemon, candidates, views: new Map(),
      missing: collectMissing ? [] : null };

    const projects = new Map();
    for (const entry of roots) {
      const list = projects.get(entry.project);
      if (list ? list.length >= SESSIONS_PER_PROJECT : projects.size >= PROJECT_LIMIT) continue;
      const view = this.view(entry, ctx);
      if (!view) continue;
      if (list) list.push(view); else projects.set(entry.project, [view]);
    }
    const active = [];
    for (const entry of roots) {
      if (!candidates.has(entry.file)) continue;
      const view = this.view(entry, ctx);
      if (view && view.status !== 'completed') active.push(view);
    }
    const counted = new Set();
    let lastActive = '';
    for (const entry of roots) {
      if (counted.has(entry.project)) continue;
      const meta = this.metadata(entry, ctx);
      const valid = meta && (entry.runtime === 'claude'
        ? !!meta.preview || fs.existsSync(path.join(entry.dir, entry.id, 'subagents'))
        : !meta.invalid);
      if (!valid) continue;
      counted.add(entry.project);
      if (entry.lastActive > lastActive) lastActive = entry.lastActive;
    }
    if (ctx.missing?.length) return { missing: ctx.missing };

    const item = (view) => {
      const out = { sessionId: view.sessionId, preview: view.preview, status: view.status,
        lastActive: view.lastActive, agentCount: view.agentCount };
      if (view.isAgent) { out.isAgent = true; out.agentName = view.agentName; }
      return out;
    };
    const visible = active.filter((view) => view.status === 'running'
      || !(Date.parse(view.lastActive) < now - NEEDS_INPUT_WINDOW_MS));
    return {
      device: {
        projectCount: counted.size,
        runningCount: active.filter((view) => view.status === 'running').length,
        needsInputCount: active.filter((view) => view.status === 'needs_input').length,
        lastActive,
      },
      sessions: visible.map((view) => ({ ...item(view), projectHash: view.project, projectName: this.shortName(view.project),
        ...(view.status === 'needs_input' && view.agentDetail ? { agentDetail: view.agentDetail } : {}) })),
      recentProjects: [...projects.values()].map((list) => ({ projectHash: list[0].project,
        projectName: this.shortName(list[0].project), lastActive: list[0].lastActive, sessions: list.map(item) })),
    };
  }

  // Parse everything the home answer needs in small slices so the event loop stays responsive.
  async warm() {
    await this.build();
    for (;;) {
      const result = this.compute({ collectMissing: true });
      if (!result.missing) break;
      const ctx = { now: Date.now(), codexRunning: getCodexRunningInfo(), missing: null };
      for (let i = 0; i < result.missing.length; i++) {
        this.metadata(result.missing[i], ctx);
        if (i % 5 === 4) await yieldToLoop();
      }
      await yieldToLoop();
    }
    this.ready = true;
    this.markDirty();
  }

  shortName(projectHash) {
    if (!this.names.has(projectHash)) {
      const name = readableProjectName(projectHash);
      this.names.set(projectHash, name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name);
    }
    return this.names.get(projectHash);
  }

  // The revision embeds a per-process id so a restarted Bridge never matches an old one.
  home(knownRevision) {
    if (this.dirty || !this.answer) {
      const next = this.compute();
      const changed = JSON.stringify(next) !== JSON.stringify(this.answer);
      this.answer = next;
      this.dirty = false;
      if (changed) this.revision++;
    }
    const revision = `${this.boot}.${this.revision}`;
    if (knownRevision === revision) return { revision, notModified: true };
    return { revision, ...this.answer };
  }
}

export const homeIndex = new HomeIndex();
