import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import process from 'process';
import { pathToFileURL } from 'url';
import { BRIDGE_HOME } from './config.mjs';

const MAX_REQUEST_BYTES = 1024 * 1024;

export function claudeHookEndpoint(home = BRIDGE_HOME, platform = process.platform) {
  if (platform === 'win32') {
    const suffix = crypto.createHash('sha256').update(home).digest('hex').slice(0, 12);
    return `\\\\.\\pipe\\baton-claude-hook-${suffix}`;
  }
  return path.join(home, 'claude-hook.sock');
}

export function formatClaudeHookResponse(response = {}) {
  if (response.action === 'allow') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'Approved through Baton.',
      },
    };
  }

  const reason = response.action === 'answer' && response.answerText
    ? response.answerText
    : (response.reason || 'The user denied this tool call through Baton.');
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

export class ClaudeHookServer {
  constructor(options = {}) {
    this.endpoint = options.endpoint || claudeHookEndpoint();
    this.onRequest = options.onRequest || (() => {});
    this.server = null;
    this.sockets = new Set();
  }

  start() {
    if (this.server) return Promise.resolve();
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(this.endpoint); } catch {}
      fs.mkdirSync(path.dirname(this.endpoint), { recursive: true });
    }
    this.server = net.createServer((socket) => this.#handleSocket(socket));
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server = null;
        reject(error);
      };
      this.server.once('error', onError);
      this.server.listen(this.endpoint, () => {
        this.server.off('error', onError);
        if (process.platform !== 'win32') {
          try { fs.chmodSync(this.endpoint, 0o600); } catch {}
        }
        resolve();
      });
    });
  }

  async close() {
    const server = this.server;
    this.server = null;
    if (!server) return;
    for (const socket of this.sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(this.endpoint); } catch {}
    }
  }

  #handleSocket(socket) {
    this.sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    let registered = false;
    let responded = false;
    let disconnect = null;

    const reply = (payload) => {
      if (responded || socket.destroyed) return false;
      responded = true;
      socket.end(`${JSON.stringify(payload)}\n`);
      return true;
    };

    socket.on('data', (chunk) => {
      if (registered) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      registered = true;
      try {
        const message = JSON.parse(buffer.slice(0, newline));
        disconnect = this.onRequest(message.input || {}, reply) || null;
      } catch {
        reply({ action: 'pass' });
      }
    });

    socket.on('close', () => {
      this.sockets.delete(socket);
      if (!responded && typeof disconnect === 'function') disconnect();
    });
    socket.on('error', () => {});
  }
}

export async function runClaudeHookRelay(options = {}) {
  const endpoint = options.endpoint || claudeHookEndpoint();
  const inputText = options.inputText ?? await new Promise((resolve) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { text += chunk; });
    process.stdin.on('end', () => resolve(text));
  });

  let input;
  try { input = JSON.parse(inputText); } catch { return null; }

  return await new Promise((resolve) => {
    const socket = net.createConnection(endpoint);
    let buffer = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ type: 'claude_hook_request', input })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        finish(response.action === 'pass' ? null : formatClaudeHookResponse(response));
      } catch {
        finish(null);
      }
    });
    socket.on('end', () => finish(null));
    socket.on('error', () => finish(null));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const response = await runClaudeHookRelay();
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
}
