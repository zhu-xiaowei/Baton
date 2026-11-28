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

// A large file goes up in parts, each sealed on its own, so only one part is in memory.
async function uploadParts(file, prepared, onProgress, signal) {
  const { parts } = prepared;
  const id = await parts.start();
  const etags = [];
  for (let n = 0; n * parts.size < file.size || n === 0; n++) {
    const body = new Blob([await prepared.seal(file.slice(n * parts.size, (n + 1) * parts.size), n * parts.records)]);
    etags.push(await put(await parts.url(id, n + 1), body, {}, loaded =>
      onProgress(Math.round(100 * Math.min(1, (n * parts.size + loaded * body.size) / file.size))), signal));
  }
  await parts.complete(id, etags);
}

export async function uploadAttachment(file, prepared, onProgress, signal) {
  if (prepared.parts) return uploadParts(file, prepared, onProgress, signal);
  const urls = [...new Set([prepared.url, prepared.fallbackUrl].filter(Boolean))];
  const body = prepared.seal ? new Blob([await prepared.seal(file)]) : file;
  for (const url of urls) {
    try {
      await put(url, body, prepared.headers, loaded => onProgress(Math.round(100 * loaded)), signal);
      return;
    } catch (error) {
      if (signal.aborted || url === urls.at(-1)) throw error;
    }
  }
  throw new Error('No upload URL');
}
