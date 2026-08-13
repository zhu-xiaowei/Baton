import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import WebSocket from 'ws';
import { spawnExecutable } from './platform.mjs';
import {
  resolveCodexBin,
  resolveCodexHomes,
} from './runtime-capabilities.mjs';

export const CODEX_APP_SERVER_REQUEST_TIMEOUT_MS = 120_000;
const MAX_WEBSOCKET_MESSAGE_BYTES = 64 * 1024 * 1024;

function managedSocketPath(options = {}) {
  if (typeof options.socketPath === 'string') return options.socketPath;
  if (options.socketPath === false
    || options.spawnFn
    || (options.platform || process.platform) === 'win32') return '';
  for (const home of options.codexHomes || resolveCodexHomes(options.env)) {
    const candidate = path.join(
      home,
      'app-server-control',
      'app-server-control.sock',
    );
    try {
      if (fs.statSync(candidate).isSocket()) return candidate;
    } catch {}
  }
  return '';
}

class CodexUnixSocketTransport extends EventEmitter {
  constructor(socketPath, options = {}) {
    super();
    this.socketPath = socketPath;
    this.webSocketFactory = options.webSocketFactory
      || ((url) => new WebSocket(url, {
        handshakeTimeout: 3000,
        maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES,
        perMessageDeflate: false,
      }));
    this.socket = null;
    this.connectPromise = null;
  }

  connect() {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise((resolve, reject) => {
      const socket = this.webSocketFactory(`ws+unix://${this.socketPath}:/`);
      this.socket = socket;
      let opened = false;
      socket.once('open', () => {
        opened = true;
        resolve(this);
      });
      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          const error = new Error('Codex app-server sent a non-text WebSocket message');
          if (this.listenerCount('error')) this.emit('error', error);
          socket.terminate();
          return;
        }
        this.emit('message', data.toString());
      });
      socket.on('error', (error) => {
        if (!opened) reject(error);
        else if (this.listenerCount('error')) this.emit('error', error);
      });
      socket.on('close', () => this.emit('close'));
    });
    return this.connectPromise;
  }

  get writable() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  writeText(text) {
    if (!this.writable) throw new Error('Codex app-server socket is not writable');
    this.socket.send(text);
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    const closed = new Promise((resolve) => socket.once('close', resolve));
    const timer = setTimeout(() => socket.terminate(), 500);
    timer.unref?.();
    try {
      if (socket.readyState === WebSocket.OPEN) socket.close();
      else socket.terminate();
    } catch {
      socket.terminate();
    }
    return closed.finally(() => clearTimeout(timer));
  }
}

export class CodexAppServerClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.bin = options.bin || null;
    this.cwd = options.cwd || os.homedir();
    this.spawnFn = options.spawnFn;
    this.runtime = {
      platform: options.platform || process.platform,
      nodeExecutable: options.nodeExecutable || process.execPath,
    };
    this.socketOptions = {
      socketPath: options.socketPath,
      webSocketFactory: options.webSocketFactory,
      codexHomes: options.codexHomes,
      env: options.env,
      spawnFn: options.spawnFn,
      platform: options.platform || process.platform,
    };
    this.requestTimeout = options.requestTimeout ?? CODEX_APP_SERVER_REQUEST_TIMEOUT_MS;
    this.clientInfo = options.clientInfo || {
      name: 'agentpeek',
      title: 'AgentPeek',
      version: '0.0.0',
    };
    this.proc = null;
    this.socketTransport = null;
    this.pending = new Map();
    this.nextId = 1;
    this.generation = 0;
    this.startPromise = null;
    this.stderr = '';
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    if ((this.proc && !this.proc.killed) || this.socketTransport?.writable) return this;
    this.startPromise = this.#startAndInitialize().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async #startAndInitialize() {
    const socketPath = managedSocketPath(this.socketOptions);
    if (socketPath) {
      try {
        return await this.#connectAndInitialize(socketPath);
      } catch (error) {
        this.stderr = `managed app-server unavailable: ${error.message}`;
      }
    }
    return this.#spawnAndInitialize();
  }

  async #connectAndInitialize(socketPath) {
    const transport = new CodexUnixSocketTransport(socketPath, this.socketOptions);
    await transport.connect();
    this.socketTransport = transport;
    this.stderr = '';
    this.generation++;
    transport.on('message', (message) => this.#handleLine(message));
    transport.on('error', (error) => this.#handleSocketExit(transport, error));
    transport.on('close', () => this.#handleSocketExit(
      transport,
      new Error('Codex app-server socket closed'),
    ));
    try {
      await this.#initialize();
      return this;
    } catch (error) {
      if (this.socketTransport === transport) this.socketTransport = null;
      await transport.close().catch(() => {});
      throw error;
    }
  }

  async #spawnAndInitialize() {
    const bin = this.bin || resolveCodexBin();
    if (!bin) throw new Error('Codex executable not found');

    const proc = spawnExecutable(bin, ['app-server', '--stdio'], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }, this.spawnFn, this.runtime);
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
      await this.#initialize();
      return this;
    } catch (error) {
      if (this.proc === proc) this.proc = null;
      proc._agentpeekReadline?.close();
      try { proc.kill('SIGTERM'); } catch {}
      throw error;
    }
  }

  async #initialize() {
    await this.#request('initialize', {
      clientInfo: this.clientInfo,
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized', {});
    this.emit('ready', { generation: this.generation });
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
    const text = JSON.stringify(message);
    if (this.socketTransport?.writable) {
      this.socketTransport.writeText(text);
      return;
    }
    if (!this.proc?.stdin?.writable) throw new Error('Codex app-server is not writable');
    this.proc.stdin.write(`${text}\n`);
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
    this.#rejectPending(error);
    this.emit('exit', error);
  }

  #handleSocketExit(transport, error) {
    if (this.socketTransport !== transport) return;
    this.socketTransport = null;
    this.#rejectPending(error);
    this.emit('exit', error);
  }

  #rejectPending(error) {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  stop() {
    const transport = this.socketTransport;
    this.socketTransport = null;
    if (transport) {
      this.#rejectPending(new Error('Codex app-server stopped'));
      return transport.close();
    }
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
    this.#rejectPending(new Error('Codex app-server stopped'));
    return closed.finally(() => clearTimeout(timer));
  }
}
