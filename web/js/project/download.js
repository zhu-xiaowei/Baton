import { harmonyBridge, harmonyCall, harmonySend } from '../harmony.js';

export function nativeDownloads() {
  return !!window.__TAURI_INTERNALS__ || !!harmonyBridge();
}

// iOS (share sheet) and HarmonyOS (save dialog) save one file at a time, so their download stops
// when the viewer closes. iPadOS reports a Mac user agent; touch support tells them apart.
export function nativeDownloadsStopOnClose() {
  const navigator = window.navigator;
  return !!harmonyBridge() || nativeDownloads() && (/iPhone|iPad|iPod/.test(navigator.userAgent)
    || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

// iOS's share sheet and the HarmonyOS save dialog open only after the bytes arrive.
export function nativeSaveOpensAfterTransfer() {
  return nativeDownloadsStopOnClose();
}

export async function cancelNativeDownload() {
  if (harmonyBridge()) {
    try { harmonySend('cancelDownload'); } catch {}
    return;
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke('plugin:file-download|cancel').catch(() => {});
}

function contentType(file) {
  return file.contentType && file.contentType !== 'application/octet-stream'
    ? file.contentType : file.previewType || 'application/octet-stream';
}

// ArkWeb ignores <a download>, so the shell downloads and opens the system save dialog.
async function harmonySave(method, args, onProgress) {
  const result = await harmonyCall(method, args, onProgress);
  return { status: result?.status || 'saved_as' };
}

// onProgress(fraction) only fires for native saves: a browser download reports progress in its own UI.
export async function downloadFile(file, onProgress) {
  if (harmonyBridge()) return harmonySave('download', { url: file.url, name: file.name }, onProgress);
  if (nativeDownloads()) {
    const { invoke, Channel } = await import('@tauri-apps/api/core');
    const progress = new Channel();
    progress.onmessage = ({ loaded, total }) => { if (total > 0) onProgress?.(loaded / total); };
    return invoke('plugin:file-download|download', {
      url: file.url, name: file.name, mime: contentType(file), onProgress: progress,
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

// Bytes made on this device: native apps write them directly, so saving needs no network.
export async function saveGeneratedFile(blob, name) {
  if (nativeDownloads()) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
    if (harmonyBridge()) return harmonySave('save', { name, data });
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke('plugin:file-download|save', { name, mime: blob.type, data });
  }
  const url = URL.createObjectURL(blob);
  try { return await downloadFile({ url, name }); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

// Native plugins reject with a plain string; anything without readable text keeps just the summary.
export function downloadFailure(error) {
  const reason = typeof error === 'string' ? error : error?.message;
  return reason ? 'Download failed: ' + reason : 'Download failed.';
}
