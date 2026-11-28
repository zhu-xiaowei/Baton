// A URL <video>/<audio> or a download can use for a stored file: the native shells answer it on a
// loopback port (preview_proxy), browsers in a Service Worker; both get the bytes from source.js.
import { invoke } from '@tauri-apps/api/core';
import { harmonyBridge } from '../harmony.js';
import { previewInvoke, previewListen, previewReset } from '../preview-native.js';
import { transfer } from '../../../bridge/transfer-store.mjs';
import { register, releasePlayback, respond } from './source.js';

const BLOB_MAX = 256 * 1024 * 1024;
const WRITE_BYTES = 256 * 1024;
// Android writes are POSTs that wait for the player to read; one per stream keeps its few connections free.
const IN_FLIGHT = /Android/i.test(globalThis.navigator?.userAgent || '') ? 1 : 3;
const encoder = new TextEncoder();

export { releasePlayback };

export async function mediaUrl(file, options = {}) {
  if (!file.sealed) return transfer.url(file.key, options.download ? { download: file.name, sealed: false } : { sealed: false });
  const base = window.__TAURI_INTERNALS__ && !harmonyBridge() ? `${await loopback()}/m/`
    : await worker() && new URL('__media/', location.href).href;
  if (base) return base + register(file, options);
  if (file.size > BLOB_MAX) throw new Error('This file is too large to open here. Download it on a computer.');
  return transfer.url(file.key, { sealed: true, contentType: file.previewType, ...(options.download ? { download: file.name } : {}) });
}

// The chunks (each ≤ one record) joined into writes of at most WRITE_BYTES.
async function* batches(body) {
  let parts = [];
  let size = 0;
  for await (const chunk of body) {
    if (size && size + chunk.length > WRITE_BYTES) { yield concat(parts, size); parts = []; size = 0; }
    parts.push(chunk);
    size += chunk.length;
  }
  if (size) yield concat(parts, size);
}

function concat(parts, size) {
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

let origin = null;
function loopback() {
  origin ??= (async () => {
    const id = crypto.randomUUID();
    const sockets = new Map();
    let port = '';
    const mine = (handler) => (event) => { if (event.payload.tunnelId === id) handler(event.payload); };
    await previewListen('preview-socket-open', mine(({ streamId }) => {
      sockets.set(streamId, { text: '', controller: new AbortController() });
      previewInvoke('preview_credit', { streamId, bytes: 64 * 1024 }).catch(() => {});
    }));
    await previewListen('preview-socket-bytes', mine(({ streamId, data }) => {
      const socket = sockets.get(streamId);
      if (!socket || socket.started) return;
      socket.text += atob(data);
      if (socket.text.includes('\r\n\r\n')) { socket.started = true; serveSocket(streamId, socket, port); }
    }));
    const end = mine(({ streamId }) => {
      sockets.get(streamId)?.controller.abort();
      sockets.delete(streamId);
      previewInvoke('preview_close_socket', { streamId }).catch(() => {}); // frees its slot in Rust
    });
    await previewListen('preview-socket-fin', end);
    await previewListen('preview-socket-close', end);
    await previewListen('preview-listener-closed', mine(() => { origin = null; }));
    await previewReset();
    const url = await previewInvoke('preview_start', { tunnelId: id, preferredPort: 49152 + Math.floor(Math.random() * 8000), mode: 'media' });
    port = new URL(url).port;
    return url;
  })();
  origin.catch(() => { origin = null; });
  return origin;
}

async function serveSocket(streamId, socket, port) {
  const [head] = socket.text.split('\r\n\r\n');
  const [line, ...lines] = head.split('\r\n');
  const [method, target] = line.split(' ');
  const headers = Object.fromEntries(lines.map((entry) => [entry.slice(0, entry.indexOf(':')).trim().toLowerCase(), entry.slice(entry.indexOf(':') + 1).trim()]));
  // Only this page's loopback names: another site cannot reach it through DNS rebinding.
  const host = /^(127\.0\.0\.1|localhost|\[::1\]):(\d+)$/.exec(headers.host || '');
  const token = /^\/m\/([0-9a-f]{32})(?:\?.*)?$/.exec(target || '')?.[1];
  const reply = respond(host && host[2] === port && token, headers.range, method);
  const write = writer(streamId);
  try {
    await write(encoder.encode(`HTTP/1.1 ${reply.status} ${reply.reason}\r\n${Object.entries(reply.headers)
      .map(([name, value]) => `${name}: ${value}\r\n`).join('')}Connection: close\r\n\r\n`));
    if (reply.body) for await (const bytes of batches(reply.body(socket.controller.signal))) await write(bytes);
    await write.flush();
    await previewInvoke('preview_shutdown_write', { streamId });
  } catch {
    previewInvoke('preview_close_socket', { streamId }).catch(() => {});
  }
}

// Writes keep their order on the Rust side (seq); a few stay in flight for throughput.
function writer(streamId) {
  let seq = 0;
  let failed = null;
  const pending = new Set();
  const write = async (bytes) => {
    if (failed) throw failed;
    const done = send(streamId, seq++, bytes);
    pending.add(done);
    done.then(() => pending.delete(done), (error) => { failed ??= error; pending.delete(done); });
    if (pending.size >= IN_FLIGHT) await Promise.race(pending);
  };
  write.flush = async () => { await Promise.allSettled(pending); if (failed) throw failed; };
  return write;
}

// Android passes an invoke body as a JSON number array, so bytes go to a loopback POST there instead.
let sink = null;
async function send(streamId, seq, bytes) {
  if (!/Android/i.test(navigator.userAgent)) {
    return invoke('media_write', bytes, { headers: { 'x-stream': streamId, 'x-seq': String(seq) } });
  }
  sink ??= invoke('media_sink');
  const [port, secret] = await sink;
  const response = await fetch(`http://127.0.0.1:${port}/w/${secret}/${streamId}?seq=${seq}`, { method: 'POST', body: bytes });
  if (!response.ok) throw new Error('Media write failed');
}

let registration = null;
let listening = false;
function worker() {
  registration ??= (async () => {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return false;
    if (!listening) navigator.serviceWorker.addEventListener('message', (event) => { if (event.data?.media) serveWorker(event.data, event.ports[0]); });
    listening = true;
    await navigator.serviceWorker.register('media-sw.js', { scope: './' });
    if (!navigator.serviceWorker.controller) {
      // After a hard reload the page is not controlled until the worker claims it.
      const changed = new Promise((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
        setTimeout(resolve, 1500);
      });
      (await navigator.serviceWorker.ready).active?.postMessage('claim');
      await changed;
    }
    return !!navigator.serviceWorker.controller;
  })().catch(() => false);
  registration.then((ok) => { if (!ok) registration = null; });
  return registration;
}

function serveWorker({ media, range, method }, port) {
  const reply = respond(media, range, method);
  const controller = new AbortController();
  const body = reply.body?.(controller.signal)[Symbol.asyncIterator]();
  port.postMessage({ status: reply.status, headers: reply.headers, body: !!body });
  if (!body) return port.close();
  port.onmessage = async ({ data }) => {
    if (data === 'cancel') { controller.abort(); body.return?.(); port.close(); return; }
    try {
      const next = await body.next();
      if (next.done) { port.postMessage({ done: true }); port.close(); return; }
      const chunk = next.value.slice();
      port.postMessage({ chunk: chunk.buffer }, [chunk.buffer]);
    } catch {
      port.postMessage({ error: true });
      port.close();
    }
  };
}
