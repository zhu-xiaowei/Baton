// The Bridge's Session catalog for v2: home, project list and session list are answered from
// memory. Each JSONL file keeps a small summary (session-summary.mjs).
//
// Warm-up (newest files first, in workers) reads each file's head and tail. Requests are
// answered once it completes. Watchers call touch() afterwards;
// appends cost only the new bytes.
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { Worker } from 'worker_threads';
import { CLAUDE_PROJECTS, CODEX_STATUS_STALE_MS } from './config.mjs';
import {
  cachedDaemonSessions, getRunningInfo, getSessionStatus, normalizeProjectHash, previewText,
  readableProjectName, readClaudeFirstPrompts,
} from './session.mjs';
import { CODEX_SESSION_INDEX, codexSessionIdFromPath, getCodexRunningInfo, readCodexThreadNames, walkJsonl } from './codex-session.mjs';
import { discoverClaudeSubagents } from './claude-subagent.mjs';
import { projectHashFromCwd, runtimeDescriptor, runtimeDescriptors, runtimeModules, storageSessionId } from './session-identity.mjs';
import { repositoryIdentity } from './repository-identity.mjs';
import { resolveCodexHomes } from './runtime-capabilities.mjs';
import { advance, claudePreview, codexView, newState, summarize, titlesBefore } from './session-summary.mjs';

const WORKERS = 2;
const HOME_PROJECTS = 15;
const HOME_SESSIONS_PER_PROJECT = 5;
const NEEDS_INPUT_WINDOW_MS = 7 * 86400_000;
const CLAUDE_FRESH_MS = 300_000;
const SUBAGENT_FRESH_MS = 15_000;
const RUNNING_INFO_TTL_MS = 5000;
// Status also changes with time alone (15 s / 5 min / 15 min / 7 day windows).
const ANSWER_TTL_MS = 15_000;
const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

// Thousands of records share a few directories, projects and models.
const strings = new Map();
const intern = (value) => {
  if (!value) return value;
  const known = strings.get(value);
  if (known !== undefined) return known;
  strings.set(value, value);
  return value;
};

// Catalogs of registered runtimes: 'file' sources summarize files like Claude/Codex; 'rows' sources
// (SQLite) list rows, refreshed when a watched path changes.
const sources = (kind) => runtimeDescriptors().filter((d) => d.catalog?.kind === kind);

const newestFirst = (a, b) => (b.ms - a.ms) || (a.sessionId < b.sessionId ? 1 : a.sessionId > b.sessionId ? -1 : 0);

function compact(state) {
  if (state) {
    state.model = intern(state.model);
    if (state.meta) state.meta.cwd = intern(state.meta.cwd);
  }
  return state;
}

export class SessionIndex {
  constructor({ statuses, claudeRoot = CLAUDE_PROJECTS, codexHomes, workers = WORKERS } = {}) {
    this.statuses = statuses || new Map();
    this.claudeRoot = claudeRoot;
    this.codexHomes = codexHomes;
    this.workers = workers;
    this.records = new Map();   // file → record
    this.subagents = new Map(); // root file → { count, children? }
    this.names = new Map();     // projectHash → readable path
    this.cwdProjects = new Map();
    this.repositoryRoots = null; // Codex repository_url → primary checkout root
    this.sentPrompts = new Map(); // Claude id → prompt Baton sent before CC wrote it
    this.history = null;
    this.threadNames = new Map(); // Codex home → { mtime, names }
    this.boot = randomUUID().slice(0, 8);
    this.revision = 0;
    this.homeAnswer = null;
    this.catalogCache = null;
    this.snapshotCache = null;
    this.running = null;
    this.refreshingRunning = false;
    this.rowSync = new Map(); // rows descriptor → { cursor, busy, pending }
    this.readyPromise = new Promise((resolve) => { this.resolveReady = resolve; });
  }

  homes() {
    this.homeList ||= this.codexHomes || resolveCodexHomes();
    return this.homeList;
  }

  // ---------- files ----------
  enumerate() {
    const found = [];
    let projects = [];
    try { projects = fs.readdirSync(this.claudeRoot); } catch {}
    for (const project of projects) {
      const dir = path.join(this.claudeRoot, project);
      let names = [];
      try { names = fs.readdirSync(dir); } catch {}
      for (const name of names) {
        if (name.endsWith('.jsonl') && !name.startsWith('.')) found.push(path.join(dir, name));
      }
    }
    for (const home of this.homes()) walkJsonl(path.join(home, 'sessions'), found);
    for (const d of sources('file')) found.push(...d.catalog.files());
    return found;
  }

  // A new record from the file's location, or null when it is not a session file.
  record(file) {
    let stat;
    try { stat = fs.statSync(file); } catch { return null; }
    if (!stat.isFile() || !stat.size) return null;
    for (const d of sources('file')) {
      const match = d.catalog.match(file);
      if (match) return { runtime: d.runtime, ...match, file, size: stat.size, ms: stat.mtime.getTime(), ino: stat.ino, state: null, local: false, view: undefined };
    }
    const home = this.homes().find((h) => file.startsWith(path.join(h, 'sessions') + path.sep));
    if (home) {
      const id = codexSessionIdFromPath(file);
      if (!id) return null;
      return { file, runtime: 'codex', id, home, size: stat.size, ms: stat.mtime.getTime(), ino: stat.ino, state: null, local: false, view: undefined };
    }
    if (path.dirname(path.dirname(file)) !== this.claudeRoot) return null;
    const dir = intern(path.dirname(file));
    return { file, runtime: 'claude', id: path.basename(file, '.jsonl'), dir, project: intern(normalizeProjectHash(path.basename(dir))),
      size: stat.size, ms: stat.mtime.getTime(), ino: stat.ino, state: null, local: false, view: undefined };
  }

  // Full read on this thread: new files and rewritten files.
  readLocally(rec) {
    try {
      rec.state = compact(advance(rec.file, rec.runtime, rec.id, newState(rec.runtime)));
    } catch {
      rec.state = null;
    }
    rec.local = true;
    rec.view = undefined;
  }

  // Brings a record's state up to the file's current size after its stat changed.
  catchUp(rec, stat) {
    if (!rec.state) return;
    if (stat.ino !== rec.ino || stat.size < rec.state.offset) {
      rec.ino = stat.ino;
      this.readLocally(rec);
    } else if (stat.size > rec.state.offset) {
      try { compact(advance(rec.file, rec.runtime, rec.id, rec.state)); } catch {}
      rec.view = undefined;
    }
  }

  // Warm-up result for one file; a file this thread has read itself since keeps its own state.
  accept(file, state) {
    const rec = this.records.get(file);
    if (!rec || rec.local) return;
    let stat;
    try { stat = fs.statSync(file); } catch { this.records.delete(file); return; }
    if (!state) { this.readLocally(rec); return; }
    rec.state = compact(state);
    rec.view = undefined;
    rec.size = stat.size;
    rec.ms = stat.mtime.getTime();
    this.catchUp(rec, stat);
  }

  async warm() {
    const started = Date.now();
    const files = [];
    for (const file of this.enumerate()) {
      const rec = this.record(file);
      if (!rec || this.records.has(file)) continue;
      this.records.set(file, rec);
      files.push(rec);
    }
    files.sort((a, b) => b.ms - a.ms);
    const jobs = files.map((rec) => [rec.file, rec.runtime, rec.id]);
    if (this.workers > 0 && jobs.length > 64) await this.warmInWorkers(jobs);
    else for (const [file, runtime, id] of jobs) {
      let state = null;
      try { state = summarize(file, runtime, id); } catch {}
      this.accept(file, state);
    }
    // A worker that failed left its files unread.
    for (const rec of files) if (!rec.state && !rec.local && this.records.get(rec.file) === rec) this.readLocally(rec);
    for (const d of sources('rows')) await this.refreshRows(d);
    this.markDirty();
    this.snapshot();
    this.resolveReady();
    void this.fillTitles();
    console.log(`[session-index] ${this.records.size} files in ${Date.now() - started}ms`);
  }

  // Round-robin shards keep every worker on the newest files first.
  warmInWorkers(jobs) {
    const count = Math.min(this.workers, jobs.length);
    const shards = Array.from({ length: count }, () => []);
    jobs.forEach((job, i) => shards[i % count].push(job));
    return Promise.all(shards.map((files) => new Promise((resolve) => {
      const worker = new Worker(new URL('./session-index-worker.mjs', import.meta.url), { workerData: { files, runtimeModules: runtimeModules() } });
      worker.on('message', (results) => { for (const [file, state] of results) this.accept(file, state); });
      worker.once('error', (error) => console.error(`[session-index] worker failed: ${error.message}`));
      worker.once('exit', resolve);
    })));
  }

  // Running Claude sessions may hold a title in the skipped middle that CC re-stamps only later;
  // read those few files backwards, a block at a time, until their latest title is found.
  async fillTitles() {
    const now = Date.now();
    const { claude } = this.runningInfo(now);
    const live = new Set([...claude.sessions, ...(claude.liveStatuses?.keys() || []), ...cachedDaemonSessions().keys()]);
    for (const rec of this.records.values()) {
      if (rec.runtime !== 'claude' || !rec.state?.skipped || (!live.has(rec.id) && now - rec.ms > CLAUDE_FRESH_MS)) continue;
      try {
        while (titlesBefore(rec.file, rec.state)) await new Promise((resolve) => setImmediate(resolve));
      } catch {}
      rec.view = undefined;
      this.markDirty();
    }
  }

  // A session started from the App may write its first prompt only later (a forked Skill).
  notePrompt(sessionId, text) {
    if (!text) return;
    this.sentPrompts.set(sessionId, text);
    for (const rec of this.records.values()) if (rec.id === sessionId) rec.view = undefined;
    this.markDirty();
  }

  // Called by the watchers for every changed JSONL (subagent files included).
  touch(file) {
    const rows = sources('rows').find((d) => d.catalog.watchPaths().includes(file));
    if (rows) return this.refreshRows(rows);
    const registered = sources('file').some((d) => d.catalog.match(file));
    if (!registered && !file.endsWith('.jsonl')) return;
    const parts = file.split(path.sep);
    const sub = parts.lastIndexOf('subagents');
    if (sub > 1 && !registered) {
      const root = parts.slice(0, sub - 1).join(path.sep) + path.sep + parts[sub - 1] + '.jsonl';
      this.subagents.delete(root);
      if (this.records.has(root)) this.records.get(root).view = undefined;
      this.markDirty();
      return;
    }
    let stat;
    try { stat = fs.statSync(file); } catch { stat = null; }
    const rec = this.records.get(file);
    if (!stat || !stat.size) {
      if (rec) { this.records.delete(file); this.markDirty(); }
      return;
    }
    if (rec) {
      rec.size = stat.size;
      rec.ms = stat.mtime.getTime();
      this.catchUp(rec, stat);
    } else {
      const fresh = this.record(file);
      if (!fresh) return;
      this.records.set(file, fresh);
      this.readLocally(fresh);
    }
    this.markDirty();
  }

  // A change seen while refreshing is read by one more pass, never dropped.
  async refreshRows(d) {
    const sync = this.rowSync.get(d) || this.rowSync.set(d, { cursor: null }).get(d);
    if (sync.busy) { sync.pending = true; return; }
    sync.busy = true;
    try {
      do {
        sync.pending = false;
        const { upserts = [], deletes = [], cursor } = await d.catalog.refresh(sync.cursor);
        sync.cursor = cursor;
        for (const row of upserts) {
          const file = `rows:${d.runtime}:${row.id}`;
          this.records.set(file, { file, runtime: d.runtime, id: row.id, size: row.size || 0, ms: row.ms, ino: 0,
            state: row, local: true, view: undefined });
        }
        for (const id of deletes) this.records.delete(`rows:${d.runtime}:${id}`);
        if (upserts.length || deletes.length) this.markDirty();
      } while (sync.pending);
    } catch (error) {
      // The cursor stays, so the next change reads again.
      console.error(`[session-index] ${d.runtime} refresh failed: ${error.message}`);
    } finally {
      sync.busy = false;
    }
  }

  // After deletions: drop records whose files are gone and pick up any new ones.
  rescan() {
    const present = new Set(this.enumerate());
    for (const file of this.records.keys()) if (!present.has(file) && !file.startsWith('rows:')) this.records.delete(file);
    for (const d of sources('rows')) void this.refreshRows(d);
    for (const file of present) if (!this.records.has(file)) this.touch(file);
    this.subagents.clear();
    this.names.clear();
    this.cwdProjects.clear();
    this.repositoryRoots = null;
    this.markDirty();
  }

  markDirty() {
    this.catalogCache = null;
    this.snapshotCache = null;
  }

  // lastKnownStatus changed: statuses are recomputed, the grouping stays.
  markStatus() {
    this.snapshotCache = null;
  }

  // ---------- derived data ----------
  // history.jsonl (Claude first prompts) and session_index.jsonl (Codex thread names) are
  // re-read when their mtime changes; the views that use them are recomputed.
  refreshExternal() {
    const history = path.join(path.dirname(this.claudeRoot), 'history.jsonl');
    let mtime = 0;
    try { mtime = fs.statSync(history).mtimeMs; } catch {}
    if (this.history?.mtime !== mtime) {
      let prompts = new Map();
      try { prompts = readClaudeFirstPrompts(history); } catch {}
      this.history = { mtime, prompts };
      for (const rec of this.records.values()) if (rec.runtime === 'claude') rec.view = undefined;
    }
    for (const home of this.homes()) {
      let indexMtime = 0;
      try { indexMtime = fs.statSync(path.join(home, CODEX_SESSION_INDEX)).mtimeMs; } catch {}
      if (this.threadNames.get(home)?.mtime === indexMtime) continue;
      let names = new Map();
      try { names = readCodexThreadNames(home); } catch {}
      this.threadNames.set(home, { mtime: indexMtime, names });
      for (const rec of this.records.values()) if (rec.home === home) rec.view = undefined;
    }
  }

  cwdProject(cwd, repositoryUrl) {
    if (!this.cwdProjects.has(cwd)) {
      this.cwdProjects.set(cwd, projectHashFromCwd(this.codexProjectCwd(cwd, repositoryUrl), this.claudeRoot));
    }
    return this.cwdProjects.get(cwd);
  }

  // Path of cwd below a Codex worktree checkout (<CODEX_HOME>/worktrees/<id>/<repo>), else null.
  codexWorktreePath(cwd) {
    for (const home of this.homes()) {
      const parts = path.relative(path.join(home, 'worktrees'), cwd).split(path.sep);
      if (parts.length >= 2 && parts[0] !== '..' && !path.isAbsolute(parts[0])) return parts.slice(2);
    }
    return null;
  }

  // A worktree checkout Codex deleted can no longer be traced on disk; its sessions join the
  // checkout of another indexed session with the same git remote.
  codexProjectCwd(cwd, repositoryUrl) {
    const rest = repositoryUrl && this.codexWorktreePath(cwd);
    if (!rest || fs.existsSync(cwd)) return cwd;
    if (!this.repositoryRoots) {
      this.repositoryRoots = new Map();
      const tried = new Set();
      for (const rec of this.records.values()) {
        const meta = rec.runtime === 'codex' && rec.state?.meta;
        if (!meta?.repositoryUrl || this.repositoryRoots.has(meta.repositoryUrl) || tried.has(meta.cwd)) continue;
        tried.add(meta.cwd);
        const root = !this.codexWorktreePath(meta.cwd) && repositoryIdentity(meta.cwd)?.primaryRoot;
        if (root) this.repositoryRoots.set(meta.repositoryUrl, root);
      }
    }
    const root = this.repositoryRoots.get(repositoryUrl);
    return root ? path.join(root, ...rest) : cwd;
  }

  // Non-empty agent-*.jsonl files below a Claude root, like discoverClaudeSubagents.
  subagentCount(rec) {
    let cached = this.subagents.get(rec.file);
    if (!cached) {
      const dir = path.join(rec.dir, rec.id, 'subagents');
      let count = 0;
      try {
        for (const name of fs.readdirSync(dir)) {
          if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) continue;
          try { if (fs.statSync(path.join(dir, name)).size) count++; } catch {}
        }
      } catch {}
      cached = { count };
      this.subagents.set(rec.file, cached);
    }
    return cached.count;
  }

  // What the lists show for one file, or null when the file is not a listable session.
  view(rec) {
    if (rec.view !== undefined) return rec.view;
    let view = null;
    const source = runtimeDescriptor(rec.runtime)?.catalog;
    if (rec.state && source) view = source.view(rec, this);
    else if (rec.state) {
      if (rec.runtime === 'claude') {
        let preview = claudePreview(rec.state, this.history.prompts.get(rec.id));
        preview ||= previewText(this.sentPrompts.get(rec.id));
        const agents = this.subagentCount(rec);
        // Like the v1 watcher: a daemon agent is listed before its transcript has a prompt.
        if (preview || agents || cachedDaemonSessions().has(rec.id)) {
          view = { project: rec.project, preview: preview || 'New session', agentCount: agents };
        }
      } else {
        const codex = codexView(rec.state, this.threadNames.get(rec.home)?.names.get(rec.id));
        const project = codex && intern(this.cwdProject(codex.cwd, codex.repositoryUrl));
        if (project) view = { project, preview: codex.preview, parent: codex.parent, visible: codex.visible, agentCount: 0 };
      }
    }
    rec.view = view;
    return view;
  }

  // Root rows grouped by project, newest first. Rebuilt after any change.
  catalog() {
    if (this.catalogCache) return this.catalogCache;
    this.refreshExternal();
    const roots = new Map();          // storage id → row
    const codexChildren = [];
    for (const rec of this.records.values()) {
      const view = this.view(rec);
      if (!view) continue;
      if (view.parent) {
        if (view.visible) codexChildren.push({ rec, parent: view.parent });
        continue;
      }
      const sessionId = storageSessionId(rec.runtime, rec.id);
      const old = roots.get(sessionId);
      // The same Claude session in two project directories (worktrees): newer file, then larger.
      if (old && (old.rec.ms > rec.ms || (old.rec.ms === rec.ms && old.rec.size >= rec.size))) continue;
      roots.set(sessionId, { rec, sessionId, ms: rec.ms, project: view.project, preview: view.preview,
        agentCount: view.agentCount, children: [] });
    }
    // Visible Codex descendants count toward the root of their visible chain.
    const parentOf = new Map(codexChildren.map((child) => [child.rec.id, child.parent]));
    for (const child of codexChildren) {
      let root = child.parent;
      const seen = new Set();
      while (parentOf.has(root) && !seen.has(root)) { seen.add(root); root = parentOf.get(root); }
      const row = roots.get(storageSessionId(child.rec.runtime, root));
      if (row) { row.agentCount++; row.children.push(child.rec); }
    }
    const byProject = new Map();
    for (const row of roots.values()) {
      if (!byProject.has(row.project)) byProject.set(row.project, []);
      byProject.get(row.project).push(row);
    }
    for (const rows of byProject.values()) rows.sort(newestFirst);
    const projects = [...byProject].map(([projectHash, rows]) => ({ projectHash, rows, ms: rows[0].ms }))
      .sort((a, b) => (b.ms - a.ms) || (a.projectHash < b.projectHash ? 1 : a.projectHash > b.projectHash ? -1 : 0));
    this.catalogCache = { byProject, projects, roots: [...roots.values()].sort(newestFirst) };
    return this.catalogCache;
  }

  // Process lists are refreshed after the answer that found them stale, so a request never waits for ps.
  runningInfo(now) {
    const read = () => {
      const info = { at: Date.now(), claude: getRunningInfo(), codex: getCodexRunningInfo() };
      for (const d of runtimeDescriptors()) if (d.catalog?.running) info[d.runtime] = d.catalog.running();
      return info;
    };
    if (!this.running) this.running = read();
    else if (now - this.running.at > RUNNING_INFO_TTL_MS && !this.refreshingRunning) {
      this.refreshingRunning = true;
      setImmediate(() => {
        try { this.running = read(); } finally { this.refreshingRunning = false; }
        this.snapshotCache = null;
      });
    }
    return this.running;
  }

  // Statuses for every root: lastKnownStatus first, else computed for candidates only.
  snapshot() {
    const now = Date.now();
    if (this.snapshotCache && now - this.snapshotCache.at <= ANSWER_TTL_MS) return this.snapshotCache;
    const catalog = this.catalog();
    const { claude: claudeRunning, codex: codexRunning } = this.runningInfo(now);
    const daemon = cachedDaemonSessions();
    const liveIds = new Set([...claudeRunning.sessions, ...(claudeRunning.liveStatuses?.keys() || []), ...daemon.keys()]);
    const codexRunningNow = (rec, project) => !!rec.state?.active && (codexRunning.sessions.has(rec.id)
      || (now - rec.ms <= CODEX_STATUS_STALE_MS && codexRunning.projects.has(project)));
    for (const row of catalog.roots) {
      const rec = row.rec;
      const known = this.statuses.get(row.sessionId);
      const agent = rec.runtime === 'claude' ? daemon.get(rec.id) : null;
      let own;
      let children = [];
      if (rec.runtime === 'claude') {
        const candidate = liveIds.has(rec.id) || (now - rec.ms <= CLAUDE_FRESH_MS && claudeRunning.projects.has(path.basename(rec.dir)));
        own = known || (agent ? agent.status : candidate ? getSessionStatus(rec.id, rec.file, claudeRunning) : 'completed');
        // A Claude child can be active only while its parent runs or right after it was written.
        if (row.agentCount && (own === 'running' || this.freshSubagent(rec, now))) children = this.claudeChildren(rec, row, own, now);
      } else if (runtimeDescriptor(rec.runtime)?.catalog) {
        const { catalog: source } = runtimeDescriptor(rec.runtime);
        const running = this.running[rec.runtime];
        own = known || source.status(rec, running, now);
        children = row.children.map((child) => ({
          status: this.statuses.get(storageSessionId(rec.runtime, child.id)) || source.status(child, running, now) }));
      } else {
        own = known || (codexRunningNow(rec, row.project) ? 'running' : 'completed');
        children = row.children.map((child) => ({ status: this.statuses.get(storageSessionId('codex', child.id))
          || (codexRunningNow(child, row.project) ? 'running' : 'completed') }));
      }
      row.own = own;
      row.agent = agent;
      row.status = own === 'needs_input' || children.some((c) => c.status === 'needs_input') ? 'needs_input'
        : (own === 'running' || children.some((c) => c.status === 'running') ? 'running' : 'completed');
    }
    this.snapshotCache = { at: now, catalog };
    return this.snapshotCache;
  }

  freshSubagent(rec, now) {
    const dir = path.join(rec.dir, rec.id, 'subagents');
    try {
      return fs.readdirSync(dir).some((name) => {
        try { return now - fs.statSync(path.join(dir, name)).mtimeMs < SUBAGENT_FRESH_MS; } catch { return false; }
      });
    } catch {
      return false;
    }
  }

  // Reads every subagent transcript, so the result is kept for 15 s; touch() drops it on a change.
  claudeChildren(rec, row, status, now) {
    let cached = this.subagents.get(rec.file);
    if (!cached) this.subagents.set(rec.file, cached = { count: this.subagentCount(rec) });
    if (cached.children?.status !== status || now - cached.children.at >= SUBAGENT_FRESH_MS) {
      cached.children = { status, at: now, list: discoverClaudeSubagents(rec.dir, { nativeSessionId: rec.id, project: row.project, status }, { now }) };
    }
    return cached.children.list.map((child) => ({ status: this.statuses.get(storageSessionId('claude', child.nativeSessionId)) || child.status }));
  }

  projectPath(projectHash) {
    if (!this.names.has(projectHash)) this.names.set(projectHash, readableProjectName(projectHash));
    return this.names.get(projectHash);
  }

  projectName(projectHash) {
    const name = this.projectPath(projectHash);
    return name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
  }

  // The waiting question: a daemon agent's, else the prompt this Bridge holds (`pendingDetail`).
  detail(row) {
    return row.agent?.agentDetail || this.pendingDetail?.(row.sessionId) || '';
  }

  // ---------- answers ----------
  async home(knownRevision) {
    await this.readyPromise;
    const { catalog } = this.snapshot();
    const now = Date.now();
    const item = (row) => {
      const out = { sessionId: row.sessionId, preview: row.preview, status: row.status,
        lastActive: new Date(row.ms).toISOString(), agentCount: row.agentCount };
      if (row.agent) { out.isAgent = true; out.agentName = row.agent.agentName || ''; }
      return out;
    };
    const active = catalog.roots.filter((row) => row.status !== 'completed');
    const answer = {
      device: {
        projectCount: catalog.projects.length,
        runningCount: active.filter((row) => row.status === 'running').length,
        needsInputCount: active.filter((row) => row.status === 'needs_input').length,
        lastActive: catalog.roots.length ? new Date(catalog.roots[0].ms).toISOString() : '',
      },
      sessions: active.filter((row) => row.status === 'running' || now - row.ms <= NEEDS_INPUT_WINDOW_MS).map((row) => ({
        ...item(row), projectHash: row.project, projectName: this.projectName(row.project),
        ...(row.status === 'needs_input' && this.detail(row) ? { agentDetail: this.detail(row) } : {}),
      })),
      recentProjects: catalog.projects.slice(0, HOME_PROJECTS).map((project) => ({
        projectHash: project.projectHash, projectName: this.projectName(project.projectHash),
        lastActive: new Date(project.ms).toISOString(), sessions: project.rows.slice(0, HOME_SESSIONS_PER_PROJECT).map(item),
      })),
    };
    // The revision embeds a per-process id so a restarted Bridge never matches an old one.
    const text = JSON.stringify(answer);
    if (text !== this.homeAnswer) { this.homeAnswer = text; this.revision++; }
    const revision = `${this.boot}.${this.revision}`;
    if (knownRevision === revision) return { revision, notModified: true };
    return { revision, ...answer };
  }

  async projects({ cursor, limit } = {}) {
    await this.readyPromise;
    const { catalog } = this.snapshot();
    const list = catalog.projects.map((project) => ({ key: [project.ms, project.projectHash], project }));
    const page = paginate(list, cursor, limit);
    return {
      projects: page.items.map(({ project }) => ({
        projectHash: project.projectHash,
        projectName: this.projectName(project.projectHash),
        projectPath: this.projectPath(project.projectHash),
        sessionCount: project.rows.length,
        runningCount: project.rows.filter((row) => row.status === 'running').length,
        needsInputCount: project.rows.filter((row) => row.status === 'needs_input').length,
        lastActive: new Date(project.ms).toISOString(),
      })),
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    };
  }

  async sessions({ project, cursor, limit } = {}) {
    if (!project) throw new Error('project is required');
    await this.readyPromise;
    const { catalog } = this.snapshot();
    const rows = catalog.byProject.get(project) || [];
    const page = paginate(rows.map((row) => ({ key: [row.ms, row.sessionId], row })), cursor, limit);
    return {
      sessions: page.items.map(({ row }) => {
        const out = { sessionId: row.sessionId, preview: row.preview, lastActive: new Date(row.ms).toISOString(),
          size: row.rec.size, model: row.rec.state?.model || '', status: row.status, agentCount: row.agentCount };
        if (row.agent) { out.isAgent = true; out.agentName = row.agent.agentName || ''; }
        if (row.own === 'needs_input' && this.detail(row)) out.agentDetail = this.detail(row);
        return out;
      }),
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    };
  }
}

// Keyset paging over a list sorted by [ms, id] descending; the cursor is the last key sent.
function paginate(list, cursor, limit) {
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(limit) || PAGE_SIZE));
  let start = 0;
  if (cursor) {
    let key;
    try { key = JSON.parse(Buffer.from(String(cursor), 'base64url').toString()); } catch {}
    if (!Array.isArray(key) || typeof key[0] !== 'number' || typeof key[1] !== 'string') throw new Error('Invalid pagination cursor');
    start = list.findIndex(({ key: [ms, id] }) => ms < key[0] || (ms === key[0] && id < key[1]));
    if (start === -1) start = list.length;
  }
  const items = list.slice(start, start + size);
  const hasMore = start + size < list.length;
  return { items, hasMore, nextCursor: hasMore ? Buffer.from(JSON.stringify(items[items.length - 1].key)).toString('base64url') : null };
}

export const sessionIndex = new SessionIndex();
