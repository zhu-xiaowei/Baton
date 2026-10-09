import net from 'node:net';
import { PreviewDataChannel } from './preview-protocol.mjs';

const CHUNK_BYTES = 16 * 1024;
const WINDOW_BYTES = 128 * 1024;
const MAX_PENDING_BYTES = 512 * 1024;
const MAX_STREAMS = 24;
const MAX_TUNNELS = 4;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createPreviewBridge(options) {
  const sessions = new Map();
  let disposed = false;

  function closeSession(session, notify = true) {
    if (session.closed) return;
    session.closed = true;
    sessions.delete(session.id);
    for (const stream of session.streams.values()) {
      stream.closed = true;
      stream.socket.destroy();
    }
    session.streams.clear();
    session.channel.close();
    if (notify && !disposed) options.sendControl({
      action: 'preview_tunnel', v: 1, op: 'close', tunnelId: session.id,
    });
  }

  function send(session, message) {
    if (session.closed || !session.channel.send(message)) {
      closeSession(session);
      return false;
    }
    return true;
  }

  function closeStream(session, stream, notify = true) {
    if (stream.closed) return;
    stream.closed = true;
    session.streams.delete(stream.id);
    stream.socket.destroy();
    stream.pending.clear();
    stream.outstanding.clear();
    if (notify) send(session, { type: 'close', streamId: stream.id });
  }

  function openStream(session, streamId) {
    const existing = session.streams.get(streamId);
    if (existing) {
      if (existing.connected) send(session, { type: 'opened', streamId });
      return;
    }
    if (session.streams.size >= MAX_STREAMS) {
      send(session, { type: 'error', streamId, code: 'stream_limit' });
      return;
    }
    const socket = net.connect({ host: '127.0.0.1', port: session.port });
    socket.pause();
    const stream = {
      id: streamId, socket, closed: false, connected: false, remoteEnded: false, failed: false,
      nextOutgoing: 1, nextIncoming: 1, lastWritten: 0, pending: new Map(), pendingBytes: 0,
      outstanding: new Map(), outstandingBytes: 0, finSeq: null, flushing: false,
    };
    session.streams.set(streamId, stream);
    socket.on('connect', () => {
      if (stream.closed || session.closed) return;
      stream.connected = true;
      if (send(session, { type: 'opened', streamId })) socket.resume();
      flushIncoming(session, stream);
    });
    socket.on('data', bytes => {
      if (stream.closed || session.closed) return;
      for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
        const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
        const seq = stream.nextOutgoing++;
        stream.outstanding.set(seq, chunk.length);
        stream.outstandingBytes += chunk.length;
        if (!send(session, { type: 'bytes', streamId, seq, data: chunk.toString('base64') })) return;
      }
      if (stream.outstandingBytes >= WINDOW_BYTES) socket.pause();
      if (stream.outstandingBytes > MAX_PENDING_BYTES) closeStream(session, stream);
    });
    socket.on('end', () => {
      if (!stream.closed) {
        stream.remoteEnded = true;
        send(session, { type: 'fin', streamId, seq: stream.nextOutgoing - 1 });
      }
    });
    socket.on('error', error => {
      if (stream.closed || session.closed) return;
      stream.failed = true;
      send(session, { type: 'error', streamId,
        code: error?.code === 'ECONNREFUSED' ? 'connection_refused' : 'io_error' });
    });
    socket.on('close', () => closeStream(session, stream, !stream.remoteEnded && !stream.failed));
  }

  async function flushIncoming(session, stream) {
    if (stream.flushing || stream.closed || !stream.connected) return;
    stream.flushing = true;
    try {
      while (!stream.closed && stream.pending.has(stream.nextIncoming)) {
        const seq = stream.nextIncoming++;
        const bytes = stream.pending.get(seq);
        stream.pending.delete(seq);
        stream.pendingBytes -= bytes.length;
        await new Promise((resolve, reject) => {
          stream.socket.write(bytes, error => error ? reject(error) : resolve());
        });
        if (stream.closed) return;
        stream.lastWritten = seq;
        if (!send(session, { type: 'ack', streamId: stream.id, seq })) return;
      }
      if (!stream.closed && stream.finSeq !== null && stream.nextIncoming > stream.finSeq) {
        stream.socket.end();
      }
    } catch {
      closeStream(session, stream);
    } finally {
      stream.flushing = false;
      if (!stream.closed && stream.pending.has(stream.nextIncoming)) {
        void flushIncoming(session, stream);
      }
    }
  }

  function receive(session, message) {
    const streamId = message?.streamId;
    if (!UUID.test(streamId || '') || session.closed) return closeSession(session);
    if (message.type === 'open') return openStream(session, streamId);
    const stream = session.streams.get(streamId);
    if (!stream || stream.closed) return;
    if (message.type === 'close') return closeStream(session, stream, false);
    if (message.type === 'ack') {
      if (message.seq >= stream.nextOutgoing) return closeStream(session, stream);
      for (const [seq, size] of stream.outstanding) {
        if (seq > message.seq) break;
        stream.outstanding.delete(seq);
        stream.outstandingBytes -= size;
      }
      if (stream.outstandingBytes < WINDOW_BYTES / 2 && stream.connected) stream.socket.resume();
      return;
    }
    if (message.type === 'fin') {
      if (message.seq < stream.nextIncoming - 1 || message.seq > stream.nextIncoming + 32) {
        return closeStream(session, stream);
      }
      stream.finSeq = message.seq;
      void flushIncoming(session, stream);
      return;
    }
    if (message.type !== 'bytes') return closeStream(session, stream);
    const bytes = Buffer.from(message.data, 'base64');
    if (!bytes.length || bytes.length > CHUNK_BYTES
      || message.seq > stream.nextIncoming + 32
      || stream.pendingBytes + bytes.length > MAX_PENDING_BYTES
      || (stream.finSeq !== null && message.seq > stream.finSeq)) {
      return closeStream(session, stream);
    }
    if (message.seq < stream.nextIncoming) {
      send(session, { type: 'ack', streamId, seq: stream.lastWritten });
      return;
    }
    if (stream.pending.has(message.seq)) return;
    stream.pending.set(message.seq, bytes);
    stream.pendingBytes += bytes.length;
    void flushIncoming(session, stream);
  }

  return {
    handle(message) {
      if (disposed || message?.action !== 'preview_tunnel' || message.v !== 1
        || message.device !== options.device || !UUID.test(message.tunnelId || '')) return;
      if (message.type === 'offer') {
        if (message.side !== 'bridge' || sessions.has(message.tunnelId)
          || sessions.size >= MAX_TUNNELS || !Number.isInteger(message.port)
          || message.port < 1 || message.port > 65535) {
          options.sendControl({ action: 'preview_tunnel', v: 1, op: 'close', tunnelId: message.tunnelId });
          return;
        }
        let channel;
        try {
          channel = (options.channelFactory || (value => new PreviewDataChannel(value)))({
            key: options.key, offer: message, socketFactory: options.socketFactory,
          });
        } catch {
          options.sendControl({ action: 'preview_tunnel', v: 1, op: 'close', tunnelId: message.tunnelId });
          return;
        }
        const session = { id: message.tunnelId, port: message.port, channel, streams: new Map(), closed: false };
        sessions.set(session.id, session);
        channel.addEventListener('message', event => receive(session, event.data));
        channel.addEventListener('error', () => closeSession(session));
        channel.addEventListener('close', () => closeSession(session));
        return;
      }
      const session = sessions.get(message.tunnelId);
      if (!session) return;
      if (message.type === 'ready') session.channel.authorize(message);
      else if (message.type === 'closed' || message.type === 'error') closeSession(session, false);
    },
    detachAll() { for (const session of [...sessions.values()]) closeSession(session, false); },
    dispose() {
      disposed = true;
      for (const session of [...sessions.values()]) closeSession(session, false);
    },
  };
}
