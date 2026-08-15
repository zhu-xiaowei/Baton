// Headless stream-json process pool (ClaudePool).
//
// One persistent `claude -p --input-format stream-json --output-format stream-json`
// process per sessionId. Messages are fed over a kept-open stdin; each turn's
// output is dispatched line-by-line via callbacks. Single-writer per session →
// no jsonl double-write. See docs/headless-streaming.md.
//
// Lifecycle (litter ClaudePool model): on-demand spawn, idle reap, LRU cap.
// Reap = close stdin (CC exits cleanly, jsonl persists), never kill.

import { spawn, execFileSync } from 'child_process';
import readline from 'readline';
import { resolveClaudeBin } from './session.mjs';
import { StreamFramer } from './stream-framer.mjs';

export const HEADLESS_IDLE_TTL_MS = 10 * 60_000; // reap a session idle this long
export const HEADLESS_MAX_PROCS = 16;            // LRU-evict beyond this
export const HEADLESS_INIT_TIMEOUT_MS = 30_000;  // wait for system/init before first send
export const HEADLESS_REAP_INTERVAL_MS = 60_000;
// One live claude process bound to a sessionId.
// State machine: spawning → ready (idle|busy) → dead.
class HeadlessProc {
  constructor(pool, key, cwd, resumeId, createId, options = {}) {
    this.pool = pool;
    this.key = key;             // pool map key (sessionId, or a temp id for new sessions)
    this.cwd = cwd;
    this.createId = createId || null;  // new session: mint this sid via --session-id
    // sid known upfront for both resume (--resume) and create (--session-id); else from system/init
    this.sessionId = resumeId || createId || null;
    this.bgLocked = false;      // resume hit CC's active-bg-agent guard (EXIT with "background agent (bg)")
    this.proc = null;
    this.stdin = null;
    this.ready = false;         // system/init seen
    this.busy = false;          // a turn is generating
    this.dead = false;
    this.queue = [];            // messages waiting for idle
    this.lastActiveAt = 0;      // set via Date-free ticker (pool.now)
    this.streamId = null;       // current turn's preview id
    this._initWaiters = [];     // resolve on system/init
    this._cb = null;
    this._blockId = -1;
    this._framer = new StreamFramer((frame) => this._emitFrame(frame));
    this._pendingCtl = new Map(); // outbound control_request id → {resolve,reject,timer}
    this.noPersistence = !!options.noPersistence;
  }

  spawn() {
    const bin = this.pool.bin || resolveClaudeBin() || 'claude';
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--permission-prompt-tool', 'stdio',
    ];
    if (this.noPersistence) args.push('--no-session-persistence');
    // --session-id (new) and --resume (existing) are mutually exclusive — both makes CC swallow stdin; createId wins.
    if (this.createId) args.push('--session-id', this.createId);
    else if (this.sessionId) args.push('--resume', this.sessionId);
    this.proc = spawn(bin, args, {
      cwd: this.cwd,
      env: this.pool.env ? { ...process.env, ...this.pool.env } : undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.stdin = this.proc.stdin;

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => this._onLine(line));

    let stderr = '';
    this.proc.stderr.on('data', (d) => {
      stderr += d.toString();
      // Resume of a session still held by the daemon → CC rejects with EXIT + this msg.
      if (stderr.includes('background agent (bg)')) this.bgLocked = true;
    });
    this.proc.on('close', (code) => this._onClose(code, stderr));
    this.proc.on('error', (err) => this._onClose(-1, err.message));
  }

  _onLine(line) {
    if (!line.trim()) return;
    let o;
    try { o = JSON.parse(line); } catch { return; }
    const t = o.type;

    if (t === 'system' && o.subtype === 'init') {
      if (o.session_id) this.sessionId = o.session_id;
      if (o.cwd) this.cwd = o.cwd;
      this.ready = true;
      const waiters = this._initWaiters; this._initWaiters = [];
      for (const w of waiters) w(this);
      return;
    }

    // Partial stream: coalesce deltas (see _accumulate); boundary events flush first.
    if (t === 'stream_event') {
      const ev = o.event || {};
      const d = ev.delta || {};
      if (ev.type === 'content_block_delta' && (d.type === 'text_delta' || d.type === 'thinking_delta')) {
        this._framer.delta(this._blockId, (d.text ?? d.thinking) || '');
      } else if (ev.type === 'content_block_delta' && d.type === 'input_json_delta') {
        this._framer.input(this._blockId, d.partial_json || '');
      } else if (ev.type === 'content_block_start') {
        this._blockId++;
        const cb = ev.content_block || {};
        this._framer.start(this._blockId, cb.type || 'text', cb.name || null);
      } else if (ev.type === 'content_block_stop') {
        this._framer.stop(this._blockId);
      }
      return;
    }

    // Full authoritative rows (same uuid as jsonl → app dedupes; renders in/out cards).
    if ((t === 'assistant' || t === 'user') && o.uuid) {
      this._cb?.onMessage?.(this.streamId, o);
      return;
    }

    // CC's reply to our outbound control_request (interrupt) — resolve the waiter.
    if (t === 'control_response') {
      const rid = o.response?.request_id;
      const w = rid && this._pendingCtl.get(rid);
      if (w) {
        this._pendingCtl.delete(rid);
        clearTimeout(w.timer);
        if (o.response?.subtype === 'success') w.resolve(o.response.response);
        else w.reject(new Error(
          o.response?.error
          || o.response?.response?.error
          || 'Claude Code control request failed.',
        ));
      }
      return;
    }

    // Permission / user-interaction request
    if (t === 'control_request') {
      this._cb?.onControlRequest?.(o);
      return;
    }

    // Turn finished
    if (t === 'result') {
      const finalSeq = this._framer.finish();
      this.busy = false;
      this.pool._touch(this);
      const cb = this._cb;
      this._cb = null;
      const sid = this.streamId;
      this.streamId = null;
      cb?.onResult?.(sid, o, finalSeq); // finalSeq = total frames sent this turn
      this._drainQueue();
      return;
    }

  }

  _emitFrame(frame) {
    if (frame.t === 'start') {
      this._cb?.onBlockStart?.(
        this.streamId,
        frame.blockId,
        frame.kind,
        frame.name,
        frame.seq,
      );
    } else if (frame.t === 'delta') {
      this._cb?.onDelta?.(this.streamId, frame.chunk, frame.seq, frame.blockId);
    } else if (frame.t === 'input') {
      this._cb?.onInputDelta?.(this.streamId, frame.chunk, frame.seq, frame.blockId);
    } else if (frame.t === 'stop') {
      this._cb?.onBlockStop?.(this.streamId, frame.blockId, frame.seq);
    }
  }

  _onClose(code, detail) {
    const wasBusy = this.busy;
    this.dead = true;
    this._framer.cancel();
    this.pool._remove(this.key);
    if (this.sessionId && wasBusy) this.pool._onExit?.(this.sessionId);
    const cb = this._cb; this._cb = null;
    cb?.onError?.(this.streamId, { code, detail });
    // Fail any queued sends
    const q = this.queue; this.queue = [];
    for (const item of q) item.cb?.onError?.(item.streamId, { code, detail });
    const waiters = this._initWaiters; this._initWaiters = [];
    for (const w of waiters) w(null);
    for (const pending of this._pendingCtl.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(detail || `Claude Code exited with code ${code}.`));
    }
    this._pendingCtl.clear();
  }

  waitInit(timeoutMs) {
    if (this.ready) return Promise.resolve(this);
    if (this.dead) return Promise.resolve(null);
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      this._initWaiters.push(finish);
      setTimeout(() => finish(this.ready ? this : null), timeoutMs);
    });
  }

  // Write one user message and bind this turn's callbacks.
  _writeTurn(text, streamId, cb) {
    this.busy = true;
    this.streamId = streamId;
    this._cb = cb;
    this._blockId = -1;
    this._framer.reset(); // seq is scoped to one streamId
    this.pool._touch(this);
    const msg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
    try { this.stdin.write(JSON.stringify(msg) + '\n'); }
    catch (err) { this._onClose(-1, err.message); }
  }

  enqueue(text, streamId, cb) {
    this.queue.push({ text, streamId, cb });
  }

  _drainQueue() {
    if (this.busy || this.dead || this.queue.length === 0) return;
    const item = this.queue.shift();
    this._writeTurn(item.text, item.streamId, item.cb);
  }

  requestControl(request, timeoutMs = HEADLESS_INIT_TIMEOUT_MS) {
    if (this.dead || !this.stdin) {
      return Promise.reject(new Error('Claude Code process is unavailable.'));
    }
    const rid = 'ctl-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this._pendingCtl.delete(rid)) return;
        reject(new Error(`Claude Code ${request.subtype || 'control'} request timed out.`));
      }, timeoutMs);
      this._pendingCtl.set(rid, { resolve, reject, timer });
      try {
        this.stdin.write(JSON.stringify({
          type: 'control_request',
          request_id: rid,
          request,
        }) + '\n');
      } catch (error) {
        clearTimeout(timer);
        this._pendingCtl.delete(rid);
        reject(error);
      }
    });
  }

  // Interrupt the current turn via stdin control_request — CC gracefully aborts and flushes
  // the partial content + [Request interrupted by user] to jsonl (verified CC 2.1.220). SIGINT
  // is the fallback (hard kill, no jsonl) when CC doesn't ack in 5s. Mirrors alleycat.
  async interrupt() {
    if (this.dead || !this.proc || !this.busy) return;
    try {
      await this.requestControl({ subtype: 'interrupt' }, 5000);
    } catch {
      try { this.proc.kill('SIGINT'); } catch {}
    }
  }

  shutdown() {
    if (this.dead) return;
    try { this.stdin?.end(); } catch {}   // EOF → CC exits cleanly, jsonl persists
  }
}

export class ClaudePool {
  constructor(opts = {}) {
    this.procs = new Map();  // key → HeadlessProc
    this.idleTtl = opts.idleTtl ?? HEADLESS_IDLE_TTL_MS;
    this.maxProcs = opts.maxProcs ?? HEADLESS_MAX_PROCS;
    this.initTimeout = opts.initTimeout ?? HEADLESS_INIT_TIMEOUT_MS;
    this.bin = opts.bin || '';
    this.env = opts.env || null;
    this._inspectPending = new Map();
    this._inspectProcs = new Set();
    this._onExit = opts.onExit || null;  // (sessionId) => void, fired when a proc leaves the pool
    this._reaper = setInterval(() => this.reapIdle(), HEADLESS_REAP_INTERVAL_MS);
    if (this._reaper.unref) this._reaper.unref();
  }

  _touch(proc) { proc.lastActiveAt = Date.now(); }

  _remove(key) { this.procs.delete(key); }

  // Send a message to sessionId's process (spawn/reuse/queue). Returns
  // { sessionId, bgLocked }: sessionId resolved from system/init (or upfront for
  // resume/create); bgLocked=true when a resume was rejected by CC's active-bg-agent
  // guard (caller then stopDaemon + retries). resumeId → --resume; createId → new
  // session via --session-id (sessionId known upfront, no init wait needed to return it).
  async send(key, text, opts = {}) {
    const streamId = opts.streamId || null;
    const cb = {
      onDelta: opts.onDelta,
      onInputDelta: opts.onInputDelta,
      onBlockStart: opts.onBlockStart,
      onBlockStop: opts.onBlockStop,
      onMessage: opts.onMessage,
      onResult: opts.onResult,
      onControlRequest: opts.onControlRequest,
      onError: opts.onError,
    };

    let proc = this.procs.get(key);
    if (!proc || proc.dead) {
      // Fresh process. NOTE: `system/init` is emitted only AFTER the first stdin
      // message is written — not on spawn. So write the turn immediately, then
      // await init just to resolve the sessionId for the return value.
      if (this.procs.size >= this.maxProcs) this._evictLru();
      proc = new HeadlessProc(this, key, opts.cwd, opts.resumeId, opts.createId);
      this.procs.set(key, proc);
      proc.spawn();
      proc._writeTurn(text, streamId, cb);
      const ok = await proc.waitInit(this.initTimeout);
      if (!ok) return { sessionId: proc.sessionId, bgLocked: proc.bgLocked }; // died/timeout: onError already fired via _onClose
      return { sessionId: proc.sessionId, bgLocked: false };
    }

    if (proc.busy) proc.enqueue(text, streamId, cb);
    else proc._writeTurn(text, streamId, cb);
    return { sessionId: proc.sessionId, bgLocked: false };
  }

  // Read the same runtime-filtered catalogs used by Claude Code's TUI without
  // creating or persisting a conversation.
  async inspect(cwd) {
    const existing = this._inspectPending.get(cwd);
    if (existing) return existing;
    const pending = this._inspect(cwd);
    this._inspectPending.set(cwd, pending);
    try {
      return await pending;
    } finally {
      if (this._inspectPending.get(cwd) === pending) this._inspectPending.delete(cwd);
    }
  }

  async _inspect(cwd) {
    const key = 'inspect-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    const proc = new HeadlessProc(this, key, cwd, null, null, { noPersistence: true });
    this._inspectProcs.add(proc);
    proc.spawn();
    try {
      return await proc.requestControl({ subtype: 'initialize' }, this.initTimeout);
    } finally {
      this._inspectProcs.delete(proc);
      proc.shutdown();
    }
  }

  async inspectSession(key, cwd, subtypes) {
    let proc = this.procs.get(key);
    let temporary = false;
    if (!proc || proc.dead) {
      const inspectKey = 'inspect-session-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      proc = new HeadlessProc(this, inspectKey, cwd, key, null, { noPersistence: true });
      this._inspectProcs.add(proc);
      proc.spawn();
      temporary = true;
    }

    const result = {};
    const errors = {};
    try {
      for (const subtype of subtypes) {
        try {
          result[subtype] = await proc.requestControl({ subtype }, this.initTimeout);
        } catch (error) {
          errors[subtype] = error.message || String(error);
        }
      }
    } finally {
      if (temporary) {
        this._inspectProcs.delete(proc);
        proc.shutdown();
      }
    }
    return { result, errors };
  }

  // Release a daemon-held (bg-agent) session so --resume can take it over. `claude stop` blocks until released (~200ms) — no polling needed.
  stopDaemon(sessionId) {
    const bin = this.bin || resolveClaudeBin() || 'claude';
    try {
      execFileSync(bin, ['stop', sessionId.slice(0, 8)], { stdio: 'ignore', timeout: 10000 });
      return true;
    } catch { return false; }
  }

  // Reply to a control_request (permission). payload is the `response` object.
  replyControl(key, requestId, payload) {
    const proc = this.procs.get(key);
    if (!proc || proc.dead) return false;
    const env = { type: 'control_response', response: { request_id: requestId, subtype: 'success', response: payload } };
    try { proc.stdin.write(JSON.stringify(env) + '\n'); return true; }
    catch { return false; }
  }

  interrupt(key) { this.procs.get(key)?.interrupt(); }

  // True while a live process exists for this session.
  owns(key) { const p = this.procs.get(key); return !!p && !p.dead; }

  // Busy turns own status; idle processes may be resumed from a terminal.
  isBusy(key) { const p = this.procs.get(key); return !!p && !p.dead && p.busy; }

  reapIdle() {
    const now = Date.now();
    for (const [key, proc] of this.procs) {
      if (proc.busy || proc.dead) continue;
      if (proc.lastActiveAt && now - proc.lastActiveAt >= this.idleTtl) {
        proc.shutdown();
        this.procs.delete(key);
      }
    }
  }

  _evictLru() {
    let victim = null;
    for (const proc of this.procs.values()) {
      if (proc.busy || proc.dead) continue;
      if (!victim || proc.lastActiveAt < victim.lastActiveAt) victim = proc;
    }
    if (victim) { victim.shutdown(); this.procs.delete(victim.key); }
  }

  shutdownAll() {
    clearInterval(this._reaper);
    for (const proc of this.procs.values()) proc.shutdown();
    for (const proc of this._inspectProcs) proc.shutdown();
    this.procs.clear();
    this._inspectProcs.clear();
  }
}
