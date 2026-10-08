import { randomUUID } from 'node:crypto';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { DirectDataChannel } from './terminal-direct-protocol.mjs';
import { defaultShell, dimensions, inputBytes, spawnTerminal } from './terminal-pty.mjs';
import { resolveProjectPath } from './project/git-context.mjs';

const MAX_CLIENT_BYTES = 512 * 1024;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const CHUNK_BYTES = 16384;
const PROJECT_LIMIT = 5;
const TOTAL_LIMIT = 20;
const MANAGEMENT_TYPES = new Set(['create_session', 'select_session', 'close_session']);
const INPUT_TYPES = new Set(['input', 'resize', 'heartbeat', 'detach', 'render_ack']);
const { Terminal } = headless;
const { SerializeAddon } = serialize;

export function createSharedTerminals(options) {
  const peers = new Map();
  const sessions = new Map();
  let disposed = false;

  function rawSend(peer, message, bytes = 0) {
    if (peer.closed) return false;
    if (peer.inflightBytes + bytes > MAX_CLIENT_BYTES) {
      drop(peer, 'Terminal display is behind. Reconnect to restore.');
      return false;
    }
    const eventSeq = message.type === 'ack' ? 0 : ++peer.eventSeq;
    if (bytes) {
      peer.inflight.set(eventSeq, bytes);
      peer.inflightBytes += bytes;
    }
    const accepted = peer.channel.send({ action: 'terminal_shared', v: 1, terminalId: peer.id,
      device: options.device, projectHash: peer.projectHash, eventSeq, ...message });
    if (!accepted) drop(peer, 'Terminal disconnected.');
    return accepted;
  }

  function publish(peer, message, bytes = 0) {
    if (peer.closed) return;
    if (peer.snapshot) {
      peer.bufferedBytes += Math.max(bytes, 128);
      if (peer.bufferedBytes > MAX_CLIENT_BYTES) return drop(peer, 'Too much output during screen sync. Reconnect.');
      peer.buffered.push({ message, bytes });
    } else rawSend(peer, message, bytes);
  }

  function broadcast(session, message, bytes = 0) {
    if (session.closed) return;
    for (const peer of session.peers) publish(peer, { epoch: session.epoch, ...message }, bytes);
  }

  function projectSessions(cwd) {
    return [...sessions.values()].filter(session => session.cwd === cwd).sort((first, second) => first.number - second.number);
  }

  function sendSessions(peer) {
    rawSend(peer, { type: 'sessions', limit: PROJECT_LIMIT,
      sessions: projectSessions(peer.cwd).map(session => ({ id: session.id, name: `Terminal ${session.number}`, exited: session.exited })) });
  }

  function updateSessions(cwd) {
    for (const peer of peers.values()) if (peer.cwd === cwd) sendSessions(peer);
  }

  function drop(peer, reason, notify = true) {
    if (peer.closed || peer.closing) return;
    peer.closing = true;
    if (reason && peer.channel.readyState === 1) rawSend(peer, { type: 'error', message: reason, fatal: true });
    peer.closed = true;
    peers.delete(peer.id);
    peer.channel.close();
    peer.pending.clear();
    peer.inflight.clear();
    peer.buffered = [];
    peer.snapshot = null;
    const session = peer.session;
    session?.peers.delete(peer);
    if (notify) options.sendControl({ action: 'terminal_direct', v: 1, op: 'close', terminalId: peer.id,
      ...(reason ? { reason: reason.slice(0, 256) } : {}) });
    if (session && !disposed) broadcast(session, { type: 'peers', count: session.peers.size });
  }

  function stopProcess(session) {
    const process = session.process;
    session.process = null;
    if (!process) return;
    try { process.kill('SIGHUP'); } catch {}
    const timer = setTimeout(() => { try { process.kill('SIGKILL'); } catch {} }, 1000);
    timer.unref();
  }

  function enqueue(session, operation) {
    session.work = session.work.then(() => {
      if (!disposed && !session.closed) return operation();
    }).catch(() => {
      if (session.closed) return;
      stopProcess(session);
      session.exited = true;
      for (const peer of [...session.peers]) drop(peer, 'Terminal failed. Reconnect and create a new terminal.');
      updateSessions(session.cwd);
    });
    return session.work;
  }

  function start(session, size) {
    stopProcess(session);
    session.mirror?.dispose();
    session.epoch = randomUUID();
    session.exited = false;
    session.exitCode = null;
    session.queuedBytes = 0;
    session.cols = size.cols;
    session.rows = size.rows;
    const epoch = session.epoch;
    const mirror = new Terminal({ cols: size.cols, rows: size.rows, scrollback: 1000, allowProposedApi: true });
    const serializer = new SerializeAddon();
    mirror.loadAddon(serializer);
    session.mirror = mirror;
    session.serializer = serializer;
    const shell = defaultShell();
    const process = spawnTerminal({ shell: options.shell || shell.shell,
      shellArgs: options.shellArgs || shell.shellArgs, cwd: session.cwd, ...size });
    session.process = process;
    for (const [code, color] of [[10, 'e6e6/eded/f3f3'], [11, '0d0d/1111/1717'], [12, 'e6e6/eded/f3f3']]) {
      mirror.parser.registerOscHandler(code, data => {
        if (data !== '?') return false;
        if (session.process === process) process.write(Buffer.from(`\x1b]${code};rgb:${color}\x1b\\`));
        return true;
      });
    }
    mirror.onData(data => { if (session.process === process) process.write(Buffer.from(data)); });
    mirror.onBinary(data => { if (session.process === process) process.write(Buffer.from(data, 'binary')); });
    process.onData(bytes => {
      if (disposed || session.closed || session.epoch !== epoch) return;
      if (!Buffer.isBuffer(bytes)) return enqueue(session, () => { throw new Error('Expected PTY bytes'); });
      session.queuedBytes += bytes.length;
      if (session.queuedBytes > 256 * 1024) process.pause();
      if (session.queuedBytes > 1024 * 1024) return enqueue(session, () => { throw new Error('Mirror backlog'); });
      enqueue(session, async () => {
        if (session.closed || session.epoch !== epoch) return;
        await new Promise(resolve => mirror.write(bytes, resolve));
        if (session.closed) return;
        session.queuedBytes -= bytes.length;
        for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
          const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
          broadcast(session, { type: 'output', data: chunk.toString('base64') }, chunk.length);
        }
        if (session.queuedBytes < 64 * 1024 && session.process === process) process.resume();
      });
    });
    process.onExit(({ exitCode, signal }) => {
      if (disposed || session.closed || session.epoch !== epoch) return;
      enqueue(session, () => {
        if (session.epoch !== epoch) return;
        session.process = null;
        session.exited = true;
        session.exitCode = exitCode;
        broadcast(session, { type: 'exit', exitCode, signal });
        updateSessions(session.cwd);
      });
    });
  }

  function pumpSnapshot(peer) {
    const snapshot = peer.snapshot;
    if (!snapshot || peer.closed) return;
    while (snapshot.sent - snapshot.acked < 4 && snapshot.sent < snapshot.chunks) {
      const index = snapshot.sent++;
      const chunk = snapshot.bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
      rawSend(peer, { type: 'snapshot', epoch: snapshot.epoch, snapshotId: snapshot.id, index,
        data: chunk.toString('base64') }, chunk.length);
      if (peer.closed) return;
    }
    if (snapshot.sent !== snapshot.chunks) return;
    peer.snapshot = null;
    rawSend(peer, { type: 'synced', epoch: snapshot.epoch, snapshotId: snapshot.id });
    const buffered = peer.buffered;
    peer.buffered = [];
    peer.bufferedBytes = 0;
    for (const entry of buffered) rawSend(peer, entry.message, entry.bytes);
  }

  function snapshot(peer) {
    const session = peer.session;
    let bytes;
    let historyTruncated = false;
    try {
      bytes = Buffer.from(session.serializer.serialize());
      if (bytes.length > MAX_SNAPSHOT_BYTES) {
        bytes = Buffer.from(session.serializer.serialize({ scrollback: 0 }));
        historyTruncated = true;
      }
    } catch {
      return drop(peer, 'Cannot restore terminal screen. Reconnect.');
    }
    if (bytes.length > MAX_SNAPSHOT_BYTES) return drop(peer, 'Terminal screen too large to restore safely.');
    peer.buffered = [];
    peer.bufferedBytes = 0;
    peer.inflight.clear();
    peer.inflightBytes = 0;
    peer.snapshot = { id: randomUUID(), epoch: session.epoch, bytes, sent: 0, acked: 0,
      chunks: Math.ceil(bytes.length / CHUNK_BYTES) };
    rawSend(peer, { type: 'ready', epoch: session.epoch, sessionId: session.id, name: `Terminal ${session.number}`, cwd: session.cwd,
      cols: session.cols, rows: session.rows, peers: session.peers.size, exited: session.exited,
      exitCode: session.exitCode, snapshotId: peer.snapshot.id, snapshotBytes: bytes.length,
      snapshotChunks: peer.snapshot.chunks, historyTruncated });
    pumpSnapshot(peer);
  }

  function createSession(cwd, size, replacement = null) {
    const existing = projectSessions(cwd).filter(session => session !== replacement);
    if (existing.length >= PROJECT_LIMIT) throw new Error('Maximum of 5 terminals per project. Close one first.');
    if (sessions.size - Number(!!replacement) >= TOTAL_LIMIT) {
      for (const [key, candidate] of sessions) {
        if (candidate.cwd !== cwd && candidate.exited && ![...peers.values()].some(peer => peer.cwd === candidate.cwd)) {
          candidate.closed = true;
          candidate.mirror.dispose();
          sessions.delete(key);
        }
      }
    }
    if (sessions.size - Number(!!replacement) >= TOTAL_LIMIT) throw new Error('Maximum of 20 terminals per device. Close unused terminals.');
    let number = 1;
    while (existing.some(session => session.number === number)) number++;
    const session = { id: randomUUID(), cwd, number, peers: new Set(), work: Promise.resolve() };
    sessions.set(session.id, session);
    try { start(session, size); } catch (error) {
      sessions.delete(session.id);
      stopProcess(session);
      session.mirror?.dispose();
      throw error;
    }
    if (!replacement) updateSessions(cwd);
    return session;
  }

  function selectSession(peer, session) {
    const previous = peer.session;
    previous?.peers.delete(peer);
    peer.session = null;
    peer.snapshot = null;
    peer.buffered = [];
    peer.bufferedBytes = 0;
    peer.inflight.clear();
    peer.inflightBytes = 0;
    if (previous) broadcast(previous, { type: 'peers', count: previous.peers.size });
    peer.session = session;
    session.peers.add(peer);
    peer.snapshot = { pending: true };
    return enqueue(session, () => {
      if (peer.closed || peer.session !== session) return;
      snapshot(peer);
      broadcast(session, { type: 'peers', count: session.peers.size });
    });
  }

  function attach(peer, message) {
    if (peer.cwd) return;
    const size = dimensions(message);
    peer.cwd = (options.resolveProjectPath || resolveProjectPath)(peer.projectHash);
    const existing = projectSessions(peer.cwd);
    const session = existing.find(candidate => candidate.id === message.sessionId) || existing[0]
      || createSession(peer.cwd, size);
    sendSessions(peer);
    return selectSession(peer, session);
  }

  async function manage(peer, message) {
    try {
      if (message.type === 'create_session') {
        await selectSession(peer, createSession(peer.cwd, dimensions(message)));
      } else {
        const session = sessions.get(message.sessionId);
        if (!session || session.cwd !== peer.cwd) throw new Error('Terminal closed or unavailable.');
        if (message.type === 'select_session') await selectSession(peer, session);
        else {
          if (projectSessions(peer.cwd).length === 1) createSession(peer.cwd, { cols: session.cols, rows: session.rows }, session);
          session.closed = true;
          sessions.delete(session.id);
          stopProcess(session);
          void session.work.finally(() => session.mirror.dispose());
          const attached = [...session.peers];
          updateSessions(peer.cwd);
          await Promise.all(attached.map(attachedPeer => selectSession(attachedPeer, projectSessions(peer.cwd)[0])));
        }
      }
      rawSend(peer, { type: 'session_result', requestId: message.requestId });
    } catch (error) {
      sendSessions(peer);
      rawSend(peer, { type: 'session_result', requestId: message.requestId, error: error.message || 'Terminal operation failed.' });
    }
  }

  function apply(peer, message) {
    if (peer.closed) return;
    const session = peer.session;
    peer.lastSeen = Date.now();
    if (message.type === 'detach') return drop(peer);
    if (message.type === 'render_ack') {
      if (!Number.isSafeInteger(message.eventSeq) || message.eventSeq < 1 || message.eventSeq > peer.eventSeq) throw new Error('Invalid display acknowledgement');
      for (const [sequence, bytes] of peer.inflight) {
        if (sequence <= message.eventSeq) {
          peer.inflight.delete(sequence);
          peer.inflightBytes -= bytes;
        }
      }
      if (peer.snapshot?.id && peer.snapshot.id === message.snapshotId) {
        if (!Number.isSafeInteger(message.index) || message.index !== peer.snapshot.acked || message.index >= peer.snapshot.sent) throw new Error('Invalid snapshot acknowledgement');
        peer.snapshot.acked++;
        pumpSnapshot(peer);
      }
    } else if (message.type !== 'heartbeat') {
      if (!session || session.closed || message.epoch !== session.epoch || message.sessionId !== session.id) {
        rawSend(peer, { type: 'error', message: 'Terminal switched or closed. Previous input was ignored.', fatal: false });
      } else if (message.type === 'resize') {
        const size = dimensions(message);
        if (session.cols !== size.cols || session.rows !== size.rows) {
          session.mirror.resize(size.cols, size.rows);
          session.process?.resize(size.cols, size.rows);
          Object.assign(session, size);
          broadcast(session, { type: 'resized', ...size });
        }
      } else if (message.type === 'input' && !session.exited) {
        session.process.write(inputBytes(message.data));
      }
    }
    rawSend(peer, { type: 'ack', clientSeq: message.clientSeq });
  }

  function receive(peer, payload) {
    if (peer.closed) return;
    try {
      const message = JSON.parse(payload);
      if (message.type === 'open') {
        if (message.clientSeq !== 0) throw new Error('Invalid open sequence');
        peer.work = peer.work.then(() => attach(peer, message)).catch(error => drop(peer, error.message || 'Terminal initialization failed.'));
        return;
      }
      if ((!INPUT_TYPES.has(message.type) && !MANAGEMENT_TYPES.has(message.type)) || !Number.isSafeInteger(message.clientSeq) || message.clientSeq < 1) throw new Error('Invalid terminal input');
      if (MANAGEMENT_TYPES.has(message.type) && (typeof message.requestId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(message.requestId))) throw new Error('Invalid management request');
      if (message.type === 'input') inputBytes(message.data);
      if (message.type === 'resize') dimensions(message);
      if (message.clientSeq < peer.nextInput) return;
      if (peer.pending.has(message.clientSeq)) {
        if (JSON.stringify(peer.pending.get(message.clientSeq)) !== JSON.stringify(message)) throw new Error('Conflicting input sequence');
        return;
      }
      peer.pending.set(message.clientSeq, message);
      peer.pendingBytes += Buffer.byteLength(payload);
      if (message.clientSeq - peer.nextInput > 128 || peer.pendingBytes > MAX_CLIENT_BYTES) throw new Error('Input reorder limit exceeded');
      while (peer.pending.has(peer.nextInput)) {
        const next = peer.pending.get(peer.nextInput);
        peer.pending.delete(peer.nextInput++);
        peer.pendingBytes -= Buffer.byteLength(JSON.stringify(next));
        peer.work = peer.work.then(() => {
          if (peer.closed) return;
          if (!peer.cwd) throw new Error('Terminal has not opened');
          peer.lastSeen = Date.now();
          if (MANAGEMENT_TYPES.has(next.type)) {
            return manage(peer, next).then(() => rawSend(peer, { type: 'ack', clientSeq: next.clientSeq }));
          }
          const operation = () => {
            try { apply(peer, next); } catch { drop(peer, 'Invalid terminal request. Reconnect.'); }
          };
          return peer.session ? enqueue(peer.session, operation) : operation();
        }).catch(() => drop(peer, 'Invalid terminal request. Reconnect.'));
      }
      peer.gapSince = peer.pending.size ? peer.gapSince || Date.now() : 0;
    } catch (error) {
      drop(peer, error.message || 'Terminal initialization failed.');
    }
  }

  const watchdog = setInterval(() => {
    for (const peer of [...peers.values()]) {
      if (Date.now() - peer.lastSeen > 45000 || (peer.gapSince && Date.now() - peer.gapSince > 10000)) {
        drop(peer, 'Connection timed out. Reconnect; background terminals are retained.');
      }
    }
  }, 1000);
  watchdog.unref();

  return {
    get activeCount() { return [...sessions.values()].filter(session => !session.exited).length; },
    handle(message) {
      if (disposed || message.action !== 'terminal_direct' || message.v !== 1 || message.device !== options.device) return;
      if (message.type === 'offer') {
        if (peers.has(message.terminalId) || message.side !== 'bridge') return;
        if (!message.projectHash || peers.size >= 16) {
          options.sendControl({ action: 'terminal_direct', v: 1, op: 'close', terminalId: message.terminalId });
          return;
        }
        const channel = new DirectDataChannel({ endpoint: options.endpoint, key: options.key,
          offer: message, socketFactory: options.socketFactory });
        const peer = { id: message.terminalId, projectHash: message.projectHash, channel, eventSeq: 0, nextInput: 1,
          work: Promise.resolve(),
          pending: new Map(), pendingBytes: 0, inflight: new Map(), inflightBytes: 0, buffered: [], bufferedBytes: 0, lastSeen: Date.now() };
        peers.set(peer.id, peer);
        channel.addEventListener('open', () => {
          if (message.initialOpen) receive(peer, JSON.stringify({ ...message.initialOpen, type: 'open', clientSeq: 0 }));
        });
        channel.addEventListener('message', event => receive(peer, event.data));
        channel.addEventListener('error', () => drop(peer));
        channel.addEventListener('close', () => drop(peer));
      } else {
        const peer = peers.get(message.terminalId);
        if (!peer) return;
        if (message.type === 'ready') peer.channel.authorize(message);
        else if (message.type === 'closed' || message.type === 'error') drop(peer, null, false);
      }
    },
    detachAll() { for (const peer of [...peers.values()]) drop(peer, null, false); },
    dispose() {
      disposed = true;
      clearInterval(watchdog);
      for (const peer of [...peers.values()]) drop(peer);
      for (const session of sessions.values()) { stopProcess(session); session.mirror?.dispose(); }
      sessions.clear();
    },
  };
}
