// v2 App ⇄ Bridge request/response frames, shared by Bridge (Node) and the web App.
// Payloads above COMPRESS_MIN are deflated (raw) and base64-encoded; results are split into
// chunks that fit a signed direct frame and may arrive in any order.

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

export function rpcRequest({ requestId, method, params = {}, replyTo }) {
  return { v: RPC_VERSION, kind: 'rpc', requestId, method, params, replyTo, accept: ['deflate'] };
}

export function isRpcRequest(frame) {
  return frame?.v === RPC_VERSION && frame.kind === 'rpc' && typeof frame.requestId === 'string'
    && typeof frame.method === 'string' && typeof frame.replyTo === 'string';
}

export function rpcResultFrames(requestId, result, { deflate } = {}) {
  const json = JSON.stringify(result);
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
    v: RPC_VERSION, kind: 'rpc_result', requestId, ok: true,
    chunk: { index, count }, enc, data: data.slice(index * size, (index + 1) * size),
  }));
}

export function rpcErrorFrame(requestId, error) {
  return { v: RPC_VERSION, kind: 'rpc_result', requestId, ok: false, error: String(error || 'error'), chunk: { index: 0, count: 1 } };
}

// Collects chunks per request; returns { done, payload | error } once every chunk arrived.
export class RpcAssembler {
  constructor() {
    this.parts = new Map();
  }

  add(frame) {
    if (frame?.v !== RPC_VERSION || frame.kind !== 'rpc_result') return null;
    if (!frame.ok) {
      this.parts.delete(frame.requestId);
      return { requestId: frame.requestId, done: true, error: frame.error };
    }
    const { index, count } = frame.chunk || {};
    if (!Number.isInteger(index) || !Number.isInteger(count) || index < 0 || index >= count) return null;
    let entry = this.parts.get(frame.requestId);
    if (!entry) this.parts.set(frame.requestId, entry = { count, chunks: new Array(count), received: 0, enc: frame.enc });
    if (entry.chunks[index] === undefined) { entry.chunks[index] = frame.data; entry.received++; }
    if (entry.received < entry.count) return { requestId: frame.requestId, done: false };
    this.parts.delete(frame.requestId);
    return { requestId: frame.requestId, done: true, payload: { enc: entry.enc, data: entry.chunks.join('') } };
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
