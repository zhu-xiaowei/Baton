// Headless stream-json process pool (ClaudePool).
//
// One persistent `claude -p --input-format stream-json --output-format stream-json`
// process per sessionId. Messages are fed over a kept-open stdin; each turn's
// output is dispatched line-by-line via callbacks. Single-writer per session →
// no jsonl double-write. See docs/headless-streaming.md.
//
// Lifecycle (litter ClaudePool model): on-demand spawn, idle reap, LRU cap.
// Reap = close stdin (CC exits cleanly, jsonl persists), never kill.

import { spawn } from 'child_process';
import readline from 'readline';
import { resolveClaudeBin } from './session.mjs';

export const HEADLESS_IDLE_TTL_MS = 10 * 60_000; // reap a session idle this long
export const HEADLESS_MAX_PROCS = 16;            // LRU-evict beyond this
export const HEADLESS_INIT_TIMEOUT_MS = 30_000;  // wait for system/init before first send
export const HEADLESS_REAP_INTERVAL_MS = 60_000;

// One live claude process bound to a sessionId.
// State machine: spawning → ready (idle|busy) → dead.
class HeadlessProc {
  constructor(pool, key, cwd, resumeId) {
    this.pool = pool;
    this.key = key;             // pool map key (sessionId, or a temp id for new sessions)
    this.cwd = cwd;
    this.sessionId = resumeId || null; // known upfront for resume; else from system/init
    this.proc = null;
    this.stdin = null;
    this.ready = false;         // system/init seen
    this.busy = false;          // a turn is generating
    this.dead = false;
    this.queue = [];            // messages waiting for idle
    this.lastActiveAt = 0;      // set via Date-free ticker (pool.now)
    this.streamId = null;       // current turn's preview id
    this._initWaiters = [];     // resolve on system/init
    this._buf = '';
    this._cb = null;
    this._deltaAcc = '';
    this._deltaSeq = 0;
    this._blockId = -1;
  }

  spawn() {
    const bin = resolveClaudeBin() || 'claude';
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--permission-prompt-tool', 'stdio',
    ];
    if (this.sessionId) args.push('--resume', this.sessionId);
    this.proc = spawn(bin, args, { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.stdin = this.proc.stdin;

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => this._onLine(line));

    let stderr = '';
    this.proc.stderr.on('data', (d) => { stderr += d.toString(); });
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

    if (t === 'stream_event') {
      const ev = o.event || {};
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        this._deltaAcc += ev.delta.text || '';
        this._cb?.onDelta?.(this.streamId, this._deltaAcc, ++this._deltaSeq, this._blockId);
      } else if (ev.type === 'content_block_start') {
        this._blockId++;
        this._deltaAcc = '';
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
      this.busy = false;
      this.pool._touch(this);
      const cb = this._cb;
      this._cb = null;
      const sid = this.streamId;
      this.streamId = null;
      this._deltaAcc = '';
      cb?.onResult?.(sid, o);
      this._drainQueue();
      return;
    }

    // Complete assistant/user lines. These carry uuid + timestamp + full content
    // (incl. tool_use / tool_result) — same shape as jsonl, verified identical
    // uuids. So they ARE the authoritative message, delivered early; the caller
    // forwards them as a normal message frame. jsonl arriving later dedups by uuid.
    if (t === 'assistant' || t === 'user') {
      this._cb?.onMessage?.(this.streamId, o, this._blockId);
      return;
    }
  }

  _onClose(code, detail) {
    this.dead = true;
    this.pool._remove(this.key);
    const cb = this._cb; this._cb = null;
    cb?.onError?.(this.streamId, { code, detail });
    // Fail any queued sends
    const q = this.queue; this.queue = [];
    for (const item of q) item.cb?.onError?.(item.streamId, { code, detail });
    const waiters = this._initWaiters; this._initWaiters = [];
    for (const w of waiters) w(null);
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

  // Interrupt the current turn: SIGINT the process (headless has no Esc).
  interrupt() {
    if (this.dead || !this.proc) return;
    try { this.proc.kill('SIGINT'); } catch {}
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
    this._reaper = setInterval(() => this.reapIdle(), HEADLESS_REAP_INTERVAL_MS);
    if (this._reaper.unref) this._reaper.unref();
  }

  _touch(proc) { proc.lastActiveAt = Date.now(); }

  _remove(key) { this.procs.delete(key); }

  // Send a message to sessionId's process (spawn/reuse/queue). Returns the
  // resolved sessionId (from system/init for new sessions), or null on failure.
  // opts: { cwd, resumeId, streamId, onDelta, onMessage, onResult, onControlRequest, onError }
  //   onDelta(streamId, fullText, seq, blockId): cumulative text + monotonic seq + per-turn block id.
  //   onMessage(streamId, line, blockId): complete assistant/user line (uuid+ts+content) —
  //     authoritative message delivered early; forward as a normal message frame.
  async send(key, text, opts = {}) {
    const streamId = opts.streamId || null;
    const cb = {
      onDelta: opts.onDelta,
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
      proc = new HeadlessProc(this, key, opts.cwd, opts.resumeId);
      this.procs.set(key, proc);
      proc.spawn();
      proc._writeTurn(text, streamId, cb);
      const ok = await proc.waitInit(this.initTimeout);
      if (!ok) return proc.sessionId; // died/timeout: onError already fired via _onClose
      return proc.sessionId;
    }

    if (proc.busy) proc.enqueue(text, streamId, cb);
    else proc._writeTurn(text, streamId, cb);
    return proc.sessionId;
  }

  // Reply to a control_request (permission). payload is the `response` object.
  replyControl(key, requestId, payload) {
    const proc = this.procs.get(key);
    if (!proc || proc.dead) return false;
    const env = { type: 'control_response', response: { request_id: requestId, subtype: 'success', response: payload } };
    try { proc.stdin.write(JSON.stringify(env) + '\n'); return true; }
    catch { return false; }
  }

  // Send a plain user text message (used for AskUserQuestion answer after deny).
  sendRaw(key, text) {
    const proc = this.procs.get(key);
    if (!proc || proc.dead) return false;
    const msg = { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
    try { proc.stdin.write(JSON.stringify(msg) + '\n'); return true; }
    catch { return false; }
  }

  interrupt(key) { this.procs.get(key)?.interrupt(); }

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
    this.procs.clear();
  }
}
