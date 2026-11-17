// Preview tunnel messages, checked by the App and the Bridge. Tunnel-level: `start {port}` → `started`,
// `stop`, and `gone` for a tunnel the Bridge does not know (it restarted); the rest belong to one
// TCP stream (`streamId`).
// The App acknowledges Bridge output once per this many bytes written (flow credit only: the Bridge
// never resends); the Bridge keeps up to four of these in flight per stream.
export const PREVIEW_ACK_BYTES = 64 * 1024;
const CHUNK_BYTES = 16 * 1024;
// On relay (`maxFrameBytes` announced) chunks and acks grow with the frame limit: fewer frames.
export function previewSizes(maxFrameBytes = 0) {
  if (!maxFrameBytes) return { chunk: CHUNK_BYTES, ack: PREVIEW_ACK_BYTES };
  const chunk = Math.min(256 * 1024, Math.floor(maxFrameBytes / 4));
  return { chunk, ack: 4 * chunk };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_TYPES = new Set(['start', 'stop', 'open', 'bytes', 'ack', 'fin', 'close']);
const BRIDGE_TYPES = new Set(['started', 'gone', 'opened', 'bytes', 'ack', 'fin', 'close', 'error']);
const TUNNEL_TYPES = new Set(['start', 'stop', 'started', 'gone']);

function validDataChunk(value, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const bytes = value.length / 4 * 3 - padding;
  return bytes > 0 && bytes <= max;
}

export function validatePreviewMessage(message, side, maxChunk = CHUNK_BYTES) {
  const allowed = side === 'app' ? APP_TYPES : BRIDGE_TYPES;
  if (!message || typeof message !== 'object' || !allowed.has(message.type)) throw new Error('Invalid preview message');
  if (message.type === 'start' && !(Number.isInteger(message.port) && message.port >= 1 && message.port <= 65535)) {
    throw new Error('Invalid preview port');
  }
  if (TUNNEL_TYPES.has(message.type)) return message;
  if (!UUID.test(message.streamId || '')) throw new Error('Invalid preview message');
  if (['bytes', 'ack', 'fin'].includes(message.type)
    && (!Number.isSafeInteger(message.seq) || message.seq < 0)) throw new Error('Invalid preview sequence');
  if (message.type === 'bytes' && (message.seq < 1 || !validDataChunk(message.data, maxChunk))) {
    throw new Error('Invalid preview data');
  }
  if (message.type === 'error' && (typeof message.code !== 'string' || message.code.length > 64)) {
    throw new Error('Invalid preview error');
  }
  return message;
}
