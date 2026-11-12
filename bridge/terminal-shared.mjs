import { randomUUID } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { defaultShell, dimensions, inputBytes, spawnTerminal } from './terminal-pty.mjs';
import { resolveProjectPath } from './project/git-context.mjs';
import { PACK_MIN, packPays } from './direct-rpc-protocol.mjs';

const MAX_CLIENT_BYTES = 512 * 1024;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const CHUNK_BYTES = 16384;
// Output is sent at most every FLUSH_MS (about 60 updates a second), up to OUTPUT_MAX_BYTES per
// message, deflated here; a message whose compressed data would not fit a frame goes as chunks.
const FLUSH_MS = 16;
const OUTPUT_MAX_BYTES = 64 * 1024;
const PACKED_MAX_CHARS = 20000;
const IDLE_MS = 90_000;
const ACK_DELAY_MS = 50;
// A page this far behind stops receiving output; below CATCH_UP_BYTES it gets the current screen
// instead of what it missed (both keep 1000 lines of history, so nothing visible is lost).
const BEHIND_BYTES = 192 * 1024;
const CATCH_UP_BYTES = 64 * 1024;
const CATCH_UP_MAX_BYTES = 256 * 1024;
const MAX_PEERS = 16;
const PROJECT_LIMIT = 5;
const TOTAL_LIMIT = 20;
const MANAGEMENT_TYPES = new Set(['create_session', 'select_session', 'close_session']);
const INPUT_TYPES = new Set(['input', 'resize', 'heartbeat', 'detach', 'render_ack', 'theme']);
// OSC 10/11/12 replies (foreground, background, cursor) for the theme the latest client reported;
// TUIs such as Codex read them once at startup to pick their own surface colors.
const OSC_COLORS = {
  dark: { 10: 'e6e6/eded/f3f3', 11: '0d0d/1111/1717', 12: 'e6e6/eded/f3f3' },
  light: { 10: '1f1f/2323/2828', 11: 'ffff/ffff/ffff', 12: '1f1f/2323/2828' },
};
const { Terminal } = headless;
const { SerializeAddon } = serialize;

export function createSharedTerminals(options) {
  const peers = new Map();
  const sessions = new Map();
  let disposed = false;
  let theme = 'dark';

  // Acknowledgements ride on the next message (`ack`); only without one within ACK_DELAY_MS do
  // they go alone. They are cumulative: input is applied in clientSeq order.
  function acknowledge(peer, clientSeq) {
    if (peer.closed) return;
    peer.ackSeq = Math.max(peer.ackSeq || 0, clientSeq);
    peer.ackTimer ||= setTimeout(() => {
      peer.ackTimer = null;
      if (peer.ackSeq) rawSend(peer, { type: 'ack', clientSeq: peer.ackSeq });
    }, ACK_DELAY_MS);
  }

  function rawSend(peer, message, bytes = 0) {
    if (peer.closed) return false;
    if (peer.ackSeq) {
      message = message.type === 'ack' ? message : { ...message, ack: peer.ackSeq };
      peer.ackSeq = 0;
      clearTimeout(peer.ackTimer);
      peer.ackTimer = null;
    }
    if (peer.inflightBytes + bytes > MAX_CLIENT_BYTES) {
      drop(peer, 'Terminal display is behind. Reconnect to restore.');
      return false;
    }
    const eventSeq = message.type === 'ack' ? 0 : ++peer.eventSeq;
    if (bytes) {
      peer.inflight.set(eventSeq, bytes);
      peer.inflightBytes += bytes;
    }
    const accepted = peer.channel.send({ eventSeq, ...message });
    if (!accepted) drop(peer, 'Terminal disconnected.');
    return accepted;
  }

  function publish(peer, message, bytes = 0) {
    if (peer.closed) return;
    const output = message.type === 'output';
    if (output && peer.behind) return;
    if (peer.snapshot) {
      if (output && peer.bufferedBytes + bytes > BEHIND_BYTES) {
        peer.behind = true;
        peer.buffered = peer.buffered.filter((entry) => entry.message.type !== 'output');
        peer.bufferedBytes = peer.buffered.length * 128;
        return;
      }
      peer.bufferedBytes += Math.max(bytes, 128);
      if (peer.bufferedBytes > MAX_CLIENT_BYTES) return drop(peer, 'Too much output during screen sync. Reconnect.');
      peer.buffered.push({ message, bytes });
    } else if (output && peer.inflightBytes + bytes > BEHIND_BYTES) peer.behind = true;
    else rawSend(peer, message, bytes);
  }

  function catchUp(peer) {
    if (!peer.behind || peer.snapshot || peer.closed || peer.inflightBytes >= CATCH_UP_BYTES) return;
    const session = peer.session;
    flushOutput(session, peer); // already in the mirror
    let bytes;
    try {
      bytes = Buffer.from(session.serializer.serialize());
      if (bytes.length > CATCH_UP_MAX_BYTES) bytes = Buffer.from(session.serializer.serialize({ scrollback: 0 }));
    } catch {
      return drop(peer, 'Cannot restore terminal screen. Reconnect.');
    }
    peer.behind = false;
    let first = true;
    for (const { message, bytes: size } of outputMessages(bytes, peer.channel.deflate)) {
      rawSend(peer, { epoch: session.epoch, ...message, ...(first ? { reset: 1 } : {}) }, size);
      first = false;
    }
  }

  function broadcast(session, message, bytes = 0, except = null) {
    if (session.closed) return;
    if (message.type !== 'output') flushOutput(session);
    for (const peer of session.peers) if (peer !== except) publish(peer, { epoch: session.epoch, ...message }, bytes);
  }

  function queueOutput(session, bytes) {
    session.out.push(bytes);
    session.outBytes += bytes.length;
    // The first output after a quiet spell (an echo) goes at once; a burst is merged.
    if (session.outBytes >= OUTPUT_MAX_BYTES || (!session.outTimer && Date.now() - (session.flushedAt || 0) >= FLUSH_MS)) flushOutput(session);
    else session.outTimer ||= setTimeout(() => flushOutput(session), FLUSH_MS);
  }

  // `except`: a peer whose snapshot already holds this output.
  function flushOutput(session, except = null) {
    clearTimeout(session.outTimer);
    session.outTimer = null;
    if (!session.outBytes) return;
    const bytes = Buffer.concat(session.out);
    session.out = [];
    session.outBytes = 0;
    session.flushedAt = Date.now();
    const deflate = [...session.peers].every((peer) => peer.channel.deflate);
    for (const { message, bytes: size } of outputMessages(bytes, deflate)) broadcast(session, message, size, except);
  }

  // Output messages for `bytes`: deflated where that pays, each within the frame budget.
  function outputMessages(bytes, deflate) {
    const messages = [];
    // 'sent', 'large' (packed but over the frame budget) or false (deflate does not pay).
    const pack = (part) => {
      const plainLength = Math.ceil(part.length / 3) * 4;
      if (!deflate || plainLength < PACK_MIN) return false;
      const packed = deflateRawSync(part).toString('base64');
      if (!packPays(plainLength, packed.length)) return false;
      if (packed.length > PACKED_MAX_CHARS) return 'large';
      messages.push({ message: { type: 'output', data: packed, z: 1 }, bytes: part.length });
      return 'sent';
    };
    for (let offset = 0; offset < bytes.length; offset += OUTPUT_MAX_BYTES) {
      const part = bytes.subarray(offset, offset + OUTPUT_MAX_BYTES);
      const whole = pack(part);
      if (whole === 'sent') continue;
      for (let at = 0; at < part.length; at += CHUNK_BYTES) {
        const chunk = part.subarray(at, at + CHUNK_BYTES);
        if (whole === 'large' && pack(chunk) === 'sent') continue;
        messages.push({ message: { type: 'output', data: chunk.toString('base64') }, bytes: chunk.length });
      }
    }
    return messages;
  }

  // The PTY pauses only while the mirror falls behind it; pages that fall behind catch up instead.
  function pace(session) {
    const process = session.process;
    if (!process) return;
    if (!session.paused && session.queuedBytes > 256 * 1024) { session.paused = true; process.pause(); }
    else if (session.paused && session.queuedBytes < 64 * 1024) { session.paused = false; process.resume(); }
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

  function drop(peer, reason) {
    if (peer.closed || peer.closing) return;
    peer.closing = true;
    if (reason && peer.channel.readyState === 1) rawSend(peer, { type: 'error', message: reason, fatal: true });
    peer.closed = true;
    clearTimeout(peer.ackTimer);
    peers.delete(peer.id);
    peer.channel.close();
    peer.pending.clear();
    peer.inflight.clear();
    peer.buffered = [];
    peer.snapshot = null;
    const session = peer.session;
    session?.peers.delete(peer);
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
    session.out = [];
    session.outBytes = 0;
    clearTimeout(session.outTimer);
    session.outTimer = null;
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
    session.paused = false;
    for (const code of [10, 11, 12]) {
      mirror.parser.registerOscHandler(code, data => {
        if (data !== '?') return false;
        if (session.process === process) process.write(Buffer.from(`\x1b]${code};rgb:${OSC_COLORS[theme][code]}\x1b\\`));
        return true;
      });
    }
    mirror.onData(data => { if (session.process === process) process.write(Buffer.from(data)); });
    mirror.onBinary(data => { if (session.process === process) process.write(Buffer.from(data, 'binary')); });
    let batch = null;
    process.onData(bytes => {
      if (disposed || session.closed || session.epoch !== epoch) return;
      if (!Buffer.isBuffer(bytes)) return enqueue(session, () => { throw new Error('Expected PTY bytes'); });
      session.queuedBytes += bytes.length;
      pace(session);
      if (session.queuedBytes > 1024 * 1024) return enqueue(session, () => { throw new Error('Mirror backlog'); });
      // Reads that arrive while the mirror is busy are written in one call: one write per small
      // PTY read caps output at a few hundred KB/s.
      if (batch) return batch.push(bytes);
      batch = [bytes];
      enqueue(session, async () => {
        const chunk = batch.length === 1 ? batch[0] : Buffer.concat(batch);
        batch = null;
        if (session.closed || session.epoch !== epoch) return;
        await new Promise(resolve => mirror.write(chunk, resolve));
        if (session.closed) return;
        session.queuedBytes -= chunk.length;
        queueOutput(session, chunk);
        if (session.process === process) pace(session);
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
    catchUp(peer);
  }

  function snapshot(peer) {
    const session = peer.session;
    flushOutput(session, peer); // the mirror, and so the snapshot, already holds it
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
    peer.behind = false;
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
      catchUp(peer);
      if (peer.snapshot?.id && peer.snapshot.id === message.snapshotId) {
        if (!Number.isSafeInteger(message.index) || message.index !== peer.snapshot.acked || message.index >= peer.snapshot.sent) throw new Error('Invalid snapshot acknowledgement');
        peer.snapshot.acked++;
        pumpSnapshot(peer);
      }
    } else if (message.type === 'theme') {
      if (message.theme === 'light' || message.theme === 'dark') theme = message.theme;
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
    acknowledge(peer, message.clientSeq);
  }

  function receive(peer, message) {
    if (peer.closed) return;
    try {
      if (message.type === 'open') {
        if (message.clientSeq !== 0) throw new Error('Invalid open sequence');
        if (message.theme === 'light' || message.theme === 'dark') theme = message.theme;
        peer.work = peer.work.then(() => attach(peer, message)).catch(error => drop(peer, error.message || 'Terminal initialization failed.'));
        return;
      }
      if ((!INPUT_TYPES.has(message.type) && !MANAGEMENT_TYPES.has(message.type)) || !Number.isSafeInteger(message.clientSeq) || message.clientSeq < 1) throw new Error('Invalid terminal input');
      if (MANAGEMENT_TYPES.has(message.type) && (typeof message.requestId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(message.requestId))) throw new Error('Invalid management request');
      if (message.type === 'input') inputBytes(message.data);
      if (message.type === 'resize') dimensions(message);
      // Input the App sent again (its acknowledgement was lost): acknowledge it again.
      if (message.clientSeq < peer.nextInput) return void acknowledge(peer, peer.nextInput - 1);
      if (peer.pending.has(message.clientSeq)) {
        if (JSON.stringify(peer.pending.get(message.clientSeq)) !== JSON.stringify(message)) throw new Error('Conflicting input sequence');
        return;
      }
      peer.pending.set(message.clientSeq, message);
      peer.pendingBytes += Buffer.byteLength(JSON.stringify(message));
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
            return manage(peer, next).then(() => acknowledge(peer, next.clientSeq));
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
      if (Date.now() - peer.lastSeen > IDLE_MS || (peer.gapSince && Date.now() - peer.gapSince > 10000)) {
        drop(peer, 'Connection timed out. Reconnect; background terminals are retained.');
      }
    }
  }, 1000);
  watchdog.unref();

  return {
    get activeCount() { return [...sessions.values()].filter(session => !session.exited).length; },
    // A frame from an App terminal page (`frame.id` = its terminalId); its first message opens it.
    handle(frame) {
      if (disposed) return;
      const message = frame.m;
      let peer = peers.get(frame.id);
      if (!peer) {
        if (message.type !== 'open' || typeof message.projectHash !== 'string' || !message.projectHash) {
          // A Bridge restart forgot this terminal: tell the page, which reconnects.
          options.channel(frame).send({ type: 'error', eventSeq: 0, fatal: true, message: 'Terminal closed. Reconnecting.' });
          return;
        }
        if (peers.size >= MAX_PEERS) {
          options.channel(frame).send({ type: 'error', eventSeq: 0, fatal: true, message: 'Too many open terminals on this device.' });
          return;
        }
        peer = { id: frame.id, projectHash: message.projectHash, channel: options.channel(frame), eventSeq: 0, nextInput: 1,
          work: Promise.resolve(),
          pending: new Map(), pendingBytes: 0, inflight: new Map(), inflightBytes: 0, buffered: [], bufferedBytes: 0, lastSeen: Date.now() };
        peers.set(peer.id, peer);
      }
      peer.channel.follow(frame); // a reconnected page writes from a new connection
      receive(peer, message);
    },
    dispose() {
      disposed = true;
      clearInterval(watchdog);
      for (const peer of [...peers.values()]) drop(peer);
      for (const session of sessions.values()) { stopProcess(session); session.mirror?.dispose(); }
      sessions.clear();
    },
  };
}
