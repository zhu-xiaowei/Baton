// Newline-delimited JSON over a child's stdio: JSON-RPC 2.0 (ACP) plus raw objects (Pi's RPC mode).
const STDERR_RING = 64 << 10;
const MAX_FRAME = 64 << 20; // characters per line

export class RpcStdio {
  // onNotify(method, params); onRequest(method, params) → result, or throws for an error reply;
  // onRaw(obj) receives objects that are not JSON-RPC.
  constructor(child, { onNotify, onRequest, onRaw, maxFrame = MAX_FRAME } = {}) {
    Object.assign(this, { child, onNotify, onRequest, onRaw, maxFrame });
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
    this.error = null;
    let buf = '';
    child.stdin.on('error', () => {});
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (text) => { this.stderr = (this.stderr + text).slice(-STDERR_RING); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (text) => {
      if (this.error) return;
      buf += text;
      let s = 0;
      for (let e = buf.indexOf('\n'); e !== -1; e = buf.indexOf('\n', s)) {
        if (e - s > maxFrame) return this.fail(new Error('oversized frame'));
        this.line(buf.slice(s, e));
        s = e + 1;
      }
      buf = buf.slice(s);
      if (buf.length > maxFrame) this.fail(new Error('oversized frame'));
    });
    child.stdout.on('close', () => this.fail(new Error(`process exited${this.stderr ? `: ${this.stderr.trim().slice(-2000)}` : ''}`)));
  }

  line(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg?.jsonrpc !== '2.0') return this.onRaw?.(msg);
    if (msg.method === undefined) {
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(Object.assign(new Error(msg.error.message || 'RPC error'), { rpc: msg.error }));
      else waiter.resolve(msg.result);
    } else if (msg.id === undefined) this.onNotify?.(msg.method, msg.params);
    else this.answer(msg);
  }

  async answer({ id, method, params }) {
    if (!this.onRequest) return this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: `${method} not supported` } });
    try {
      this.write({ jsonrpc: '2.0', id, result: await this.onRequest(method, params) });
    } catch (error) {
      this.write({ jsonrpc: '2.0', id, error: { code: Number.isInteger(error?.code) ? error.code : -32603, message: String(error?.message || error) } });
    }
  }

  write(obj) {
    if (!this.error) this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  notify(method, params) { this.write({ jsonrpc: '2.0', method, params }); }

  request(method, params, { timeoutMs } = {}) {
    if (this.error) return Promise.reject(this.error);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs && setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      const done = (fn) => (value) => { clearTimeout(timer); fn(value); };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  // A broken stream rejects every pending request; later writes are dropped.
  fail(error) {
    if (this.error) return;
    this.error = error;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}
