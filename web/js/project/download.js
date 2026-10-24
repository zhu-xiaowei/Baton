// HarmonyOS NEXT shell: ArkWeb ignores <a download>, so the native bridge owns
// the transfer and the system save dialog (harmony/.../bridge/DownloadBridge.ets).
function harmonyBridge() {
  const bridge = window.harmonyDownloadBridge;
  return bridge && typeof bridge.download === 'function' ? bridge : null;
}

export function nativeDownloads() {
  return !!window.__TAURI_INTERNALS__ || !!harmonyBridge();
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

let _harmonyId = 0;
const _harmonyPending = new Map();

function harmonyDownload(bridge, file, onProgress) {
  if (!window.__onHarmonyDownload) {
    window.__onHarmonyDownload = (id, result) => {
      const pending = _harmonyPending.get(id);
      if (!pending) return;
      _harmonyPending.delete(id);
      if (result?.error) pending.reject(new Error(result.error));
      else pending.resolve({ status: result?.status || 'saved_as' });
    };
    window.__onHarmonyDownloadProgress = (id, percent) => {
      _harmonyPending.get(id)?.onProgress?.(percent);
    };
  }
  const id = ++_harmonyId;
  return new Promise((resolve, reject) => {
    _harmonyPending.set(id, { resolve, reject, onProgress });
    try {
      bridge.download(JSON.stringify({ id, url: file.url, name: file.name }));
    } catch (error) {
      _harmonyPending.delete(id);
      reject(new Error('Could not start the download'));
    }
  });
}

export async function downloadFile(file, onProgress) {
  const harmony = harmonyBridge();
  if (harmony) return harmonyDownload(harmony, file, onProgress);
  if (nativeDownloads()) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke('plugin:file-download|download', {
      url: file.url, name: file.name, mime: contentType(file),
    });
  }
  const link = document.createElement('a');
  link.href = file.url;
  link.download = file.name;
  link.rel = 'noopener noreferrer';
  document.body.appendChild(link);
  link.click();
  link.remove();
  return { status: 'started' };
}

export async function prepareSharedFile(file) {
  const maxBytes = BROWSER_SHARE_MAX_BYTES;
  if (file.size > maxBytes) throw new Error('Files over 50 MB: use Download instead of browser sharing.');
  const response = await fetch(file.url);
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
    }
  } finally { await reader.cancel(); }
  if (Number.isFinite(file.size) && size !== file.size) throw new Error('The downloaded file is incomplete. Try again.');
  const shared = new File(chunks, file.name, { type: contentType(file) });
  if (!navigator.canShare({ files: [shared] })) throw new DOMException('This browser cannot share this file type.', 'NotSupportedError');
  return shared;
}
export const BROWSER_SHARE_MAX_BYTES = 50 * 1024 * 1024;
