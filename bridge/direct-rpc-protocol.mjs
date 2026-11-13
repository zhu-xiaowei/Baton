// v2 App ⇄ Bridge frames, shared by Bridge (Node) and the web App: requests, their replies and
// receipts, pushed Session events, and terminal / preview streams. Payloads above COMPRESS_MIN are
// deflated (raw), then sealed (e2ee.mjs) and base64-encoded; they are split into chunks that fit a
// signed direct frame and may arrive in any order.

export const RPC_VERSION = 2;
const COMPRESS_MIN = 1024;
const CHUNK_CHARS = 20000;
const JSON_CHUNK_CHARS = 6000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_SIGNED_FRAME = 28 * 1024;
const CONNECTION = /^[A-Za-z0-9_+=.-]{1,256}$/;

export function toBase64(bytes) {
  if (globalThis.Buffer) return globalThis.Buffer.from(bytes).toString('base64');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(text) {
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
// sealed (e2ee.mjs session) and sent as chunks of its params, however short; only `account_key`
// goes as it is. `deflate` may return a Promise (browser streams).
export async function rpcRequestFrames(request, deflate, seal) {
  const { params, ...head } = request;
  if (!seal) return [request];
  const data = await sealJson(head, JSON.stringify(params), deflate, seal);
  const count = Math.ceil(data.length / CHUNK_CHARS);
  return Array.from({ length: count }, (_, index) => ({ ...head, chunk: { index, count }, enc: 'e',
    data: data.slice(index * CHUNK_CHARS, (index + 1) * CHUNK_CHARS) }));
}

export function isRpcRequest(frame) {
  return frame?.v === RPC_VERSION && frame.kind === 'rpc' && typeof frame.requestId === 'string'
    && typeof frame.method === 'string' && typeof frame.replyTo === 'string';
}

// Compressed when that pays, then sealed; flags bit 1 = deflated. Synchronous on Bridge.
function sealJson(head, json, deflate, seal) {
  const bytes = encoder.encode(json);
  if (!deflate || json.length <= COMPRESS_MIN) return seal(head, bytes, 0);
  const packed = deflate(bytes);
  return packed.then ? packed.then((out) => seal(head, out, 1)) : seal(head, packed, 1);
}

function chunkFrames(head, value, deflate, seal) {
  const json = JSON.stringify(value);
  const enc = seal ? 'e' : 'json'; // clear only for `account_key`
  const data = seal ? sealJson(head, json, deflate, seal) : json;
  // JSON chunks may be multi-byte UTF-8 and are escaped again inside the signed frame.
  const size = enc === 'json' ? JSON_CHUNK_CHARS : CHUNK_CHARS;
  const count = Math.max(1, Math.ceil(data.length / size));
  return Array.from({ length: count }, (_, index) => ({
    v: RPC_VERSION, ...head, chunk: { index, count }, enc, data: data.slice(index * size, (index + 1) * size),
  }));
}

export function rpcResultFrames(requestId, result, { deflate, method, seal } = {}) {
  return chunkFrames({ kind: 'rpc_result', requestId, method, ok: true }, result, deflate, seal);
}

export function rpcErrorFrame(requestId, error, method, seal) {
  error = String(error || 'error').slice(0, 2000);
  if (seal) return chunkFrames({ kind: 'rpc_result', requestId, method, ok: false }, { error }, null, seal)[0];
  return { v: RPC_VERSION, kind: 'rpc_result', requestId, method, ok: false, error, chunk: { index: 0, count: 1 } };
}

export function rpcAckFrame(requestId) {
  return { v: RPC_VERSION, kind: 'rpc_ack', requestId };
}

// A long request is still running; `progress` is what the page may show.
export function rpcProgressFrame(requestId, progress, seal) {
  const frame = { v: RPC_VERSION, kind: 'rpc_progress', requestId };
  if (progress === undefined) return frame;
  return seal ? { ...frame, enc: 'e', data: sealJson(frame, JSON.stringify(progress), null, seal) } : { ...frame, progress };
}

// A pushed Session event; `event` and `sessionId` stay readable next to the encoded payload.
export function pushFrames(id, event, { deflate, seal } = {}) {
  return chunkFrames({ kind: 'push', id, event: event.action, sessionId: event.sessionId }, event, deflate, seal);
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
    if (frame.ok === false && frame.data === undefined) {
      this.parts.delete(requestId);
      return { requestId, done: true, error: frame.error };
    }
    const { index, count } = frame.chunk || {};
    if (!Number.isInteger(index) || !Number.isInteger(count) || index < 0 || index >= count) return null;
    let entry = this.parts.get(requestId);
    if (!entry) {
      if (this.parts.size >= this.limit) this.parts.delete(this.parts.keys().next().value);
      this.parts.set(requestId, entry = { count, chunks: new Array(count), received: 0, enc: frame.enc, head: frame });
    }
    if (entry.chunks[index] === undefined) { entry.chunks[index] = frame.data; entry.received++; }
    if (entry.received < entry.count) return { requestId, done: false };
    this.parts.delete(requestId);
    return { requestId, done: true, failed: entry.head.ok === false,
      payload: { enc: entry.enc, data: entry.chunks.join(''), head: entry.head } };
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
// `open(head, data)` opens an `e` payload (e2ee.mjs session) or returns null; others are refused then.
export async function decodeRpcPayload({ enc, data, head }, inflate, open) {
  if (open && enc !== 'e') throw new Error('unsealed');
  if (enc !== 'e') return JSON.parse(data);
  const out = open && await open(head, data);
  if (!out) throw new Error('unsealed');
  return JSON.parse(decoder.decode(out.flags & 1 ? await inflate(out.body) : out.body));
}

// Terminal and preview streams: { v, kind: 'stream', ch, id, from, m }. `from` is the App's
// connection (the Bridge's reply target; the Bridge sends none), `m` the channel's own message. A message's `data` (base64 bytes)
// travels deflated (`z: 1`) when that makes it smaller. `deflate`/`inflate` may return Promises.
const STREAM_CHANNELS = new Set(['terminal', 'preview']);
// Data shorter than this does not shrink under deflate; the packed copy is used only when it saves 10%.
export const PACK_MIN = 128;
export const packPays = (plainLength, packedLength) => plainLength >= PACK_MIN && packedLength < plainLength * 0.9;

export function streamFrame(ch, id, from, m) {
  return { v: RPC_VERSION, kind: 'stream', ch, id, ...(from ? { from } : {}), m };
}

export function isStreamFrame(frame) {
  return frame?.v === RPC_VERSION && frame.kind === 'stream' && STREAM_CHANNELS.has(frame.ch)
    && typeof frame.id === 'string' && frame.id.length <= 64 && CONNECTION.test(frame.from || '')
    && !!frame.m && typeof frame.m === 'object';
}

export async function packStreamMessage(message, deflate) {
  if (!deflate || message.z || typeof message.data !== 'string' || message.data.length < PACK_MIN) return message;
  const packed = toBase64(await deflate(fromBase64(message.data)));
  return packPays(message.data.length, packed.length) ? { ...message, data: packed, z: 1 } : message;
}

export async function unpackStreamMessage(message, inflate) {
  if (!message.z) return message;
  const { z, ...rest } = message;
  return { ...rest, data: toBase64(await inflate(fromBase64(message.data))) };
}

// A sealed stream message is { e }: JSON of its fields, then "\n" and its data as raw bytes, so
// terminal output is base64-encoded once. flags bit 2 = has data.
export async function sealStreamMessage(frame, message, seal) {
  const { data, ...rest } = message;
  const head = encoder.encode(JSON.stringify(rest));
  if (typeof data !== 'string') return { e: await seal(frame, head, 0) };
  const raw = fromBase64(data);
  const body = new Uint8Array(head.length + 1 + raw.length);
  body.set(head);
  body[head.length] = 10;
  body.set(raw, head.length + 1);
  return { e: await seal(frame, body, 2) };
}

export async function openStreamMessage(frame, message, open) {
  const out = typeof message?.e === 'string' ? await open(frame, message.e) : null;
  if (!out) return null;
  if (!(out.flags & 2)) return JSON.parse(decoder.decode(out.body));
  const split = out.body.indexOf(10);
  return { ...JSON.parse(decoder.decode(out.body.subarray(0, split))), data: toBase64(out.body.subarray(split + 1)) };
}

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('');
}

async function digest(value) {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function hmac(key, value) {
  const imported = await crypto.subtle.importKey('raw', typeof key === 'string' ? encoder.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', imported, encoder.encode(value));
}

function encodePath(path) {
  return path.split('/').map((part) => encodeURIComponent(part).replace(/[!'()*]/g,
    (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
}

// A frame the data API's HTTP integration posts to `target`'s connection: the body plus the SigV4
// headers for `POST @connections/<target>`, signed with the account's temporary credentials.
export function createHeaderSigner({ endpoint, region, target, credentials, action }) {
  const base = new URL(endpoint);
  if (base.protocol !== 'https:' || base.search || base.hash || base.username || base.password
    || !CONNECTION.test(target) || !/^[a-z0-9-]+$/.test(region)
    || !credentials?.accessKeyId || !credentials.secretAccessKey || !credentials.sessionToken
    || !Number.isSafeInteger(credentials.expiresAt)) throw new Error('Invalid signing authorization');
  let cachedDate;
  let cachedKey;
  // `label` adds clear fields (the operation name) next to `action`; the gateway ignores them.
  return async (body, now = new Date(), label = {}) => {
    if (now.getTime() >= credentials.expiresAt * 1000 - 2000) throw new Error('Signing authorization expired');
    const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = stamp.slice(0, 8);
    if (cachedDate !== date) {
      cachedDate = date;
      cachedKey = hmac(`AWS4${credentials.secretAccessKey}`, date)
        .then((key) => hmac(key, region)).then((key) => hmac(key, 'execute-api')).then((key) => hmac(key, 'aws4_request'));
    }
    const signedHeaders = 'host;x-amz-date;x-amz-security-token';
    const headers = `host:${base.host}\nx-amz-date:${stamp}\nx-amz-security-token:${credentials.sessionToken}\n`;
    const path = `${base.pathname.replace(/\/$/, '')}/@connections/${target}`;
    const canonical = ['POST', encodePath(path), '', headers, signedHeaders, await digest(body)].join('\n');
    const scope = `${date}/${region}/execute-api/aws4_request`;
    const signature = hex(await hmac(await cachedKey, `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${await digest(canonical)}`));
    const frame = JSON.stringify({ action, ...label, target, body, date: stamp,
      token: credentials.sessionToken,
      authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` });
    if (encoder.encode(frame).length > MAX_SIGNED_FRAME) throw new Error('Signed frame exceeds 28 KiB');
    return frame;
  };
}

