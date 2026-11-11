// v2 App ⇄ Bridge frames, shared by Bridge (Node) and the web App: requests, their replies and
// receipts, and pushed Session events. Payloads above COMPRESS_MIN are deflated (raw) and
// base64-encoded; replies and pushes are split into chunks that fit a signed direct frame and may
// arrive in any order.

export const RPC_VERSION = 2;
const COMPRESS_MIN = 1024;
const CHUNK_CHARS = 20000;
const JSON_CHUNK_CHARS = 6000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes) {
  if (globalThis.Buffer) return globalThis.Buffer.from(bytes).toString('base64');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text) {
  if (globalThis.Buffer) return new Uint8Array(globalThis.Buffer.from(text, 'base64'));
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

// A resend keeps its requestId; `missing` asks only for those chunks of a reply already sent.
// `ack` asks for a receipt (`rpc_ack`) as soon as the request arrives.
export function rpcRequest({ requestId, method, params = {}, replyTo, missing, ack }) {
  const frame = { v: RPC_VERSION, kind: 'rpc', requestId, method, params, replyTo, accept: ['deflate'] };
  if (missing?.length) frame.missing = missing;
  if (ack) frame.ack = true;
  return frame;
}

// A request whose params do not fit one frame (a long message) is sent as chunks of its params,
// encoded like a reply. `deflate` may return a Promise (browser streams).
export async function rpcRequestFrames(request, deflate) {
  const { params, ...head } = request;
  if (JSON.stringify(params).length <= JSON_CHUNK_CHARS) return [request];
  const json = JSON.stringify(params);
  const packed = deflate ? { enc: 'deflate-b64', data: toBase64(await deflate(encoder.encode(json))) } : { enc: 'json', data: json };
  const size = packed.enc === 'json' ? JSON_CHUNK_CHARS : CHUNK_CHARS;
  const count = Math.ceil(packed.data.length / size);
  return Array.from({ length: count }, (_, index) => ({ ...head, chunk: { index, count }, enc: packed.enc,
    data: packed.data.slice(index * size, (index + 1) * size) }));
}

export function isRpcRequest(frame) {
  return frame?.v === RPC_VERSION && frame.kind === 'rpc' && typeof frame.requestId === 'string'
    && typeof frame.method === 'string' && typeof frame.replyTo === 'string';
}

function chunkFrames(head, value, deflate) {
  const json = JSON.stringify(value);
  let enc = 'json';
  let data = json;
  if (deflate && json.length > COMPRESS_MIN) {
    enc = 'deflate-b64';
    data = toBase64(deflate(encoder.encode(json)));
  }
  // JSON chunks may be multi-byte UTF-8 and are escaped again inside the signed frame.
  const size = enc === 'json' ? JSON_CHUNK_CHARS : CHUNK_CHARS;
  const count = Math.max(1, Math.ceil(data.length / size));
  return Array.from({ length: count }, (_, index) => ({
    v: RPC_VERSION, ...head, chunk: { index, count }, enc, data: data.slice(index * size, (index + 1) * size),
  }));
}

export function rpcResultFrames(requestId, result, { deflate, method } = {}) {
  return chunkFrames({ kind: 'rpc_result', requestId, method, ok: true }, result, deflate);
}

export function rpcErrorFrame(requestId, error, method) {
  return { v: RPC_VERSION, kind: 'rpc_result', requestId, method, ok: false, error: String(error || 'error'), chunk: { index: 0, count: 1 } };
}

export function rpcAckFrame(requestId) {
  return { v: RPC_VERSION, kind: 'rpc_ack', requestId };
}

// A pushed Session event; `event` and `sessionId` stay readable next to the encoded payload.
export function pushFrames(id, event, { deflate } = {}) {
  return chunkFrames({ kind: 'push', id, event: event.action, sessionId: event.sessionId }, event, deflate);
}

// Collects the chunks of a reply or push by id; returns { done, payload | error } once every
// chunk arrived. `limit` bounds unfinished entries (pushes whose chunks were lost).
export class RpcAssembler {
  constructor(limit = Infinity) {
    this.parts = new Map();
    this.limit = limit;
  }

  add(frame) {
    if (frame?.v !== RPC_VERSION || (frame.kind !== 'rpc_result' && frame.kind !== 'push')) return null;
    const requestId = frame.requestId || frame.id;
    if (frame.ok === false) {
      this.parts.delete(requestId);
      return { requestId, done: true, error: frame.error };
    }
    const { index, count } = frame.chunk || {};
    if (!Number.isInteger(index) || !Number.isInteger(count) || index < 0 || index >= count) return null;
    let entry = this.parts.get(requestId);
    if (!entry) {
      if (this.parts.size >= this.limit) this.parts.delete(this.parts.keys().next().value);
      this.parts.set(requestId, entry = { count, chunks: new Array(count), received: 0, enc: frame.enc });
    }
    if (entry.chunks[index] === undefined) { entry.chunks[index] = frame.data; entry.received++; }
    if (entry.received < entry.count) return { requestId, done: false };
    this.parts.delete(requestId);
    return { requestId, done: true, payload: { enc: entry.enc, data: entry.chunks.join('') } };
  }

  // Chunk indexes not received yet, or null when nothing arrived.
  missing(requestId) {
    const entry = this.parts.get(requestId);
    if (!entry) return null;
    const out = [];
    for (let i = 0; i < entry.count; i++) if (entry.chunks[i] === undefined) out.push(i);
    return out;
  }

  forget(requestId) {
    this.parts.delete(requestId);
  }
}

// `inflate` turns raw-deflate bytes into bytes; it may return a Promise (browser streams).
export async function decodeRpcPayload({ enc, data }, inflate) {
  const json = enc === 'deflate-b64' ? decoder.decode(await inflate(fromBase64(data))) : data;
  return JSON.parse(json);
}
