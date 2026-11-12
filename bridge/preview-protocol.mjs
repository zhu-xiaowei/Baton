// Preview tunnel messages, checked by the App and the Bridge. Tunnel-level: `start {port}` → `started`,
// `stop`, and `gone` for a tunnel the Bridge does not know (it restarted); the rest belong to one
// TCP stream (`streamId`).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_TYPES = new Set(['start', 'stop', 'open', 'bytes', 'ack', 'fin', 'close']);
const BRIDGE_TYPES = new Set(['started', 'gone', 'opened', 'bytes', 'ack', 'fin', 'close', 'error']);
const TUNNEL_TYPES = new Set(['start', 'stop', 'started', 'gone']);

function validDataChunk(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const bytes = value.length / 4 * 3 - padding;
  return bytes > 0 && bytes <= 16 * 1024;
}

export function validatePreviewMessage(message, side) {
  const allowed = side === 'app' ? APP_TYPES : BRIDGE_TYPES;
  if (!message || typeof message !== 'object' || !allowed.has(message.type)) throw new Error('Invalid preview message');
  if (message.type === 'start' && !(Number.isInteger(message.port) && message.port >= 1 && message.port <= 65535)) {
    throw new Error('Invalid preview port');
  }
  if (TUNNEL_TYPES.has(message.type)) return message;
  if (!UUID.test(message.streamId || '')) throw new Error('Invalid preview message');
  if (['bytes', 'ack', 'fin'].includes(message.type)
    && (!Number.isSafeInteger(message.seq) || message.seq < 0)) throw new Error('Invalid preview sequence');
  if (message.type === 'bytes' && (message.seq < 1 || !validDataChunk(message.data))) {
    throw new Error('Invalid preview data');
  }
  if (message.type === 'error' && (typeof message.code !== 'string' || message.code.length > 64)) {
    throw new Error('Invalid preview error');
  }
  return message;
}
