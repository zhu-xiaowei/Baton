import { fileIconHtml, fileIconName } from './file-icon.js';

export const FILE_MAX_BYTES = 512 * 1024 * 1024;

export function escapeAttachment(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

export function attachmentRef(file) {
  return '[' + encodeURIComponent(file.name).replace(/[!'()*]/g, character =>
    '%' + character.charCodeAt(0).toString(16)) + '](baton-file:' + file.key + ')';
}

export function extractAttachments(text, inlineNames = false) {
  const files = [];
  const cleaned = text.replace(/\[([^\]\r\n]*)\]\((?:baton-file:([0-9a-f]{32}(?:\.[a-z0-9]{1,16})?)|<([^<>\r\n]*[\\/]\.baton-bridge[\\/]attachments[\\/]([0-9a-f]{32}(?:\.[a-z0-9]{1,16})?))>)\)/g,
    (reference, label, remoteKey, localPath, localKey) => {
      let name;
      try { name = decodeURIComponent(label); } catch { return reference; }
      files.push({ kind: 'file', name, key: remoteKey || localKey, uploaded: true, ...(localPath ? { local: localPath } : {}) });
      return inlineNames ? name : '';
    });
  return { text: cleaned, files };
}

export function attachmentPreviewText(text) {
  return extractAttachments(text, true).text;
}

export function fileAttachmentHtml(file) {
  if (!/^[0-9a-f]{32}(?:\.[a-z0-9]{1,16})?$/.test(file.key || '')) return '';
  return '<button class="file-badge attachment-file" type="button" data-attachment-key="'
    + file.key + '" title="' + escapeAttachment(file.name) + '"'
    + (file.local ? ' data-local="' + escapeAttachment(file.local) + '"' : '') + ' onclick="openFile(\'baton-file:'
    + file.key + '\',this.title,\'\',\'\',{local:this.dataset.local})">' + fileIconHtml(file.name)
    + '<span class="file-badge-name">' + escapeAttachment(file.name) + '</span></button>';
}

export function isTextAttachment(file) {
  const icon = fileIconName(file.name);
  return file.contentType?.startsWith('text/') && !['word', 'powerpoint'].includes(icon)
    || ['console', 'css', 'docker', 'document', 'git', 'go', 'html', 'java', 'javascript',
      'json', 'markdown', 'python', 'react', 'rust', 'swift', 'toml', 'typescript', 'xml', 'yaml'].includes(icon)
    || /\.(csv|tsv)$/i.test(file.name);
}

export async function readAttachmentText(url, limit = 5 * 1024 * 1024) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Failed to download file');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = limit - size;
      text += decoder.decode(value.subarray(0, remaining), { stream: true });
      size += value.length;
      if (size > limit) { truncated = true; break; }
    }
    text += decoder.decode();
  } finally {
    await reader.cancel();
  }
  return { text, truncated };
}

// One PUT with progress (fraction of `body`); resolves the response's ETag.
function put(url, body, headers, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const upload = new XMLHttpRequest();
    const abort = () => { upload.abort(); reject(new DOMException('Upload cancelled', 'AbortError')); };
    upload.open('PUT', url);
    upload.timeout = 60 * 60 * 1000;
    Object.entries(headers).forEach(([name, value]) => upload.setRequestHeader(name, value));
    upload.upload.onprogress = event => { if (event.lengthComputable) onProgress(event.loaded / event.total); };
    upload.onload = () => upload.status >= 200 && upload.status < 300
      ? resolve(upload.getResponseHeader('ETag')) : reject(new Error('Upload failed (' + upload.status + ')'));
    upload.onerror = upload.ontimeout = () => reject(new Error('Upload failed. Check your connection.'));
    upload.onloadend = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    upload.send(body);
  });
}

// All uploads share three slots (two on phones, whose links are slower and drop more): several large
// files at once still keep that many requests in flight and sealed bodies in memory (a host gets six
// HTTP/1.1 connections). Files up to 8 MB need none.
const SMALL = 8 * 1024 * 1024;
const agent = globalThis.navigator?.userAgent || '';
let free = /iPhone|iPad|iPod|Android/.test(agent) || (globalThis.navigator?.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 2 : 3;
const queue = []; // { owner, grant }
const held = new Map(); // owner (an upload's signal) → slots it holds
const take = (owner) => held.set(owner, (held.get(owner) || 0) + 1);
async function slot(owner) {
  if (free > 0) { free--; take(owner); return; }
  await new Promise((resolve, reject) => {
    const waiter = { owner, grant: () => { owner.removeEventListener('abort', abort); take(owner); resolve(); } };
    const abort = () => { queue.splice(queue.indexOf(waiter), 1); reject(new DOMException('Upload cancelled', 'AbortError')); };
    queue.push(waiter);
    owner.addEventListener('abort', abort, { once: true });
  });
}
// A freed slot goes to the waiting upload that holds the fewest, so files advance side by side.
function release(owner) {
  const left = held.get(owner) - 1;
  if (left) held.set(owner, left); else held.delete(owner);
  if (!queue.length) { free++; return; }
  const waiter = queue.reduce((best, next) => ((held.get(next.owner) || 0) < (held.get(best.owner) || 0) ? next : best));
  queue.splice(queue.indexOf(waiter), 1);
  waiter.grant();
}
async function inSlot(signal, work) {
  await slot(signal);
  try { return await work(); } finally { release(signal); }
}

// A failed part is sent again after 1, 2, 5, 10 and 20 s (a network change), with a freshly signed
// URL each time.
const RETRY_MS = [1000, 2000, 5000, 10000, 20000];
async function putPart(url, body, onProgress, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await put(await url(), body, {}, onProgress, signal);
    } catch (error) {
      if (signal.aborted || attempt === RETRY_MS.length) throw error;
      await new Promise(resolve => setTimeout(resolve, RETRY_MS[attempt]));
    }
  }
}

// A large file goes up in parts, each sealed on its own, three lanes taking the shared slots. The
// progress shown never goes back while a part is sent again.
async function uploadParts(file, prepared, id, onProgress, cancelled) {
  const { parts } = prepared;
  // One failed part stops the others too.
  const stop = new AbortController();
  const { signal } = stop;
  const cancel = () => stop.abort();
  cancelled.addEventListener('abort', cancel, { once: true });
  if (cancelled.aborted) cancel();
  const count = Math.max(1, Math.ceil(file.size / parts.size));
  const etags = [];
  const sent = new Array(count).fill(0);
  let shown = 0;
  let next = 0;
  const lane = async () => {
    for (let n; (n = next++) < count;) {
      etags[n] = await inSlot(signal, async () => {
        const body = new Blob([await prepared.seal(file.slice(n * parts.size, (n + 1) * parts.size), n * parts.records)]);
        return putPart(() => parts.url(id, n + 1), body, loaded => {
          sent[n] = loaded * body.size;
          shown = Math.max(shown, Math.round(100 * Math.min(1, sent.reduce((a, b) => a + b, 0) / file.size)));
          if (!signal.aborted) onProgress(shown);
        }, signal);
      });
    }
  };
  try {
    await Promise.all([lane(), lane(), lane()]);
    await parts.complete(id, etags);
  } catch (error) {
    next = count;
    stop.abort();
    parts.abort(id);
    throw error;
  } finally {
    cancelled.removeEventListener('abort', cancel);
  }
}

export async function uploadAttachment(file, prepared, onProgress, signal) {
  // A self-hosted stack whose CORS predates multipart refuses the start: one PUT instead.
  const id = prepared.parts && await prepared.parts.start().catch(() => null);
  if (id) return uploadParts(file, prepared, id, onProgress, signal);
  const single = async () => {
    const urls = [...new Set([prepared.url, prepared.fallbackUrl].filter(Boolean))];
    const body = prepared.seal ? new Blob([await prepared.seal(file)]) : file;
    for (const url of urls) {
      try {
        return await put(url, body, prepared.headers, loaded => onProgress(Math.round(100 * loaded)), signal);
      } catch (error) {
        if (signal.aborted || url === urls.at(-1)) throw error;
      }
    }
  };
  await (file.size > SMALL ? inSlot(signal, single) : single());
}
