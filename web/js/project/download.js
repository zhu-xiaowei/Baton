import { downloadCancelled, runDownloadStage } from './download-task.js';

export function nativeDownloads() {
  return !!window.__TAURI_INTERNALS__;
}

export function browserCanShare() {
  const navigator = window.navigator;
  const mobile = navigator.userAgentData?.mobile || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return !nativeDownloads() && mobile && typeof navigator.share === 'function' && typeof navigator.canShare === 'function';
}

function contentType(file) {
  return file.contentType && file.contentType !== 'application/octet-stream'
    ? file.contentType : file.previewType || 'application/octet-stream';
}

export async function downloadFile(file, onProgress, { signal } = {}) {
  signal?.throwIfAborted();
  if (nativeDownloads()) {
    const { invoke, Channel } = await import('@tauri-apps/api/core');
    signal?.throwIfAborted();
    const requestId = crypto.randomUUID();
    const channel = new Channel();
    let finished = false, cancellation, rejectCancelled;
    channel.onmessage = progress => { if (!finished && !signal?.aborted) onProgress?.(progress); };
    const transfer = invoke('plugin:file-download|download', {
      url: file.url, name: file.name, mime: contentType(file), onProgress: channel, requestId,
    });
    const cancelled = new Promise((_, reject) => { rejectCancelled = reject; });
    const abort = () => {
      if (cancellation) return;
      cancellation = runDownloadStage(() => invoke('plugin:file-download|cancel', { requestId }), {
        timeout: 10_000,
      }).catch(() => {
        const error = new Error('Cancellation not confirmed. Check system Downloads before retrying.');
        error.code = 'DOWNLOAD_CANCEL_UNCONFIRMED';
        throw error;
      });
      cancellation.then(() => rejectCancelled(signal.reason || downloadCancelled()), rejectCancelled);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const result = await Promise.race([transfer, cancelled]);
      // A completed save wins a concurrent cancel; do not pretend the file was removed.
      if (result?.status === 'saved' || result?.status === 'shared') return result;
      if (signal?.aborted) {
        await cancellation;
        throw signal.reason || downloadCancelled();
      }
      return result;
    } catch (error) {
      if (!signal?.aborted) throw error;
      await cancellation;
      throw signal.reason || downloadCancelled();
    } finally {
      finished = true;
      signal?.removeEventListener('abort', abort);
    }
  }
  // Blob URLs avoid browser-specific data-URL download limits for generated images.
  const generated = file.url.startsWith('data:image/');
  const blob = generated ? await (await fetch(file.url, { signal })).blob() : null;
  signal?.throwIfAborted();
  const localUrl = blob ? URL.createObjectURL(blob) : null;
  const link = document.createElement('a');
  link.href = localUrl || file.url;
  link.download = file.name;
  link.rel = 'noopener noreferrer';
  document.body.appendChild(link);
  link.click();
  link.remove();
  if (localUrl) setTimeout(() => URL.revokeObjectURL(localUrl), 1000);
  return { status: 'started' };
}

export async function prepareSharedFile(file, onProgress, { signal } = {}) {
  const maxBytes = BROWSER_SHARE_MAX_BYTES;
  if (file.size > maxBytes) throw new Error('Files over 50 MB: use Download instead of browser sharing.');
  signal?.throwIfAborted();
  const response = await fetch(file.url, { signal });
  if (!response.ok) throw new Error('Could not download the file for sharing.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error('File is too large for browser sharing. Use Download instead.');
      chunks.push(value);
      onProgress?.({ received: size, total: file.size });
    }
  } finally { await reader.cancel(); }
  if (Number.isFinite(file.size) && size !== file.size) throw new Error('The downloaded file is incomplete. Try again.');
  const shared = new File(chunks, file.name, { type: contentType(file) });
  if (!navigator.canShare({ files: [shared] })) throw new DOMException('This browser cannot share this file type.', 'NotSupportedError');
  return shared;
}
export const BROWSER_SHARE_MAX_BYTES = 50 * 1024 * 1024;

export async function openDownloadReceipt(receipt, reveal = false) {
  if (!receipt?.id || !nativeDownloads()) throw new Error('Use your browser’s Downloads list.');
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke('plugin:file-download|' + (reveal ? 'reveal_download' : 'open_download'), { id: String(receipt.id) });
}
