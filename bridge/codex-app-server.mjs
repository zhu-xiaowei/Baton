import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import os from 'os';
import readline from 'readline';
import { resolveCodexBin } from './runtime-capabilities.mjs';

export const CODEX_APP_SERVER_REQUEST_TIMEOUT_MS = 120_000;

export class CodexAppServerClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.bin = options.bin || null;
    this.cwd = options.cwd || os.homedir();
    this.spawnFn = options.spawnFn || spawn;
    this.requestTimeout = options.requestTimeout ?? CODEX_APP_SERVER_REQUEST_TIMEOUT_MS;
    this.clientInfo = options.clientInfo || {
      name: 'agentpeek',
      title: 'AgentPeek',
      version: '0.0.0',
    };
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.generation = 0;
    this.startPromise = null;
    this.stderr = '';
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    if (this.proc && !this.proc.killed) return this;
    this.startPromise = this.#spawnAndInitialize().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async #spawnAndInitialize() {
    const bin = this.bin || resolveCodexBin();
    if (!bin) throw new Error('Codex executable not found');

    const proc = this.spawnFn(bin, ['app-server', '--stdio'], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    this.stderr = '';
    this.generation++;

    proc.stderr?.on('data', (chunk) => {
      this.stderr += chunk.toString();
      if (this.stderr.length > 16_000) this.stderr = this.stderr.slice(-16_000);
    });
    proc.on('error', (error) => this.#handleExit(proc, error));
    proc.on('close', (code, signal) => {
      this.#handleExit(proc, new Error(
        `Codex app-server exited (${code ?? signal ?? 'unknown'})`
        + (this.stderr ? `: ${this.stderr.slice(-1000)}` : ''),
      ));
    });

    const lines = readline.createInterface({ input: proc.stdout });
    lines.on('line', (line) => this.#handleLine(line));
    proc._agentpeekReadline = lines;

    try {
      await this.#request('initialize', {
        clientInfo: this.clientInfo,
        capabilities: { experimentalApi: true },
      });
      this.notify('initialized', {});
      this.emit('ready', { generation: this.generation });
      return this;
    } catch (error) {
      if (this.proc === proc) this.proc = null;
      proc._agentpeekReadline?.close();
      try { proc.kill('SIGTERM'); } catch {}
      throw error;
    }
  }

  async request(method, params = {}) {
    await this.start();
    return this.#request(method, params);
  }

  #request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, this.requestTimeout);
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.#write({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.#write({ method, params });
  }

  respond(id, result) {
    this.#write({ id, result });
  }

  respondError(id, code, message) {
    this.#write({ id, error: { code, message } });
  }

  #write(message) {
    if (!this.proc?.stdin?.writable) throw new Error('Codex app-server is not writable');
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit('protocolError', new Error(`Invalid Codex app-server JSON: ${line.slice(0, 200)}`));
      return;
    }

    if (message.id != null && !message.method) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(`${waiter.method}: ${message.error.message || 'request failed'}`);
        error.code = message.error.code;
        error.data = message.error.data;
        waiter.reject(error);
      } else {
        waiter.resolve(message.result);
      }
      return;
    }

    if (message.id != null && message.method) {
      this.emit('serverRequest', {
        id: message.id,
        method: message.method,
        params: message.params || {},
      });
      return;
    }

    if (message.method) {
      const notification = {
        method: message.method,
        params: message.params || {},
      };
      this.emit('notification', notification);
      this.emit(
        message.method === 'error' ? 'codexError' : message.method,
        notification.params,
      );
    }
  }

  #handleExit(proc, error) {
    if (this.proc !== proc) return;
    this.proc = null;
    proc._agentpeekReadline?.close();
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    this.emit('exit', error);
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    if (!proc) return Promise.resolve();
    proc._agentpeekReadline?.close();
    const closed = new Promise((resolve) => {
      proc.once('close', (code, signal) => resolve({ code, signal }));
    });
    try { proc.stdin.end(); } catch {}
    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
    }, 2000);
    timer.unref?.();
    const error = new Error('Codex app-server stopped');
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    return closed.finally(() => clearTimeout(timer));
  }
}
