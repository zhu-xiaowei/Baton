export function nativeDownloads() {
  return !!window.__TAURI_INTERNALS__;
}

// iOS saves one file at a time through the share sheet, so its download stops when the viewer closes.
// iPadOS reports a Mac user agent; touch support tells them apart.
export function nativeDownloadsStopOnClose() {
  const navigator = window.navigator;
  return nativeDownloads() && (/iPhone|iPad|iPod/.test(navigator.userAgent)
    || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export async function cancelNativeDownload() {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke('plugin:file-download|cancel').catch(() => {});
}

function contentType(file) {
  return file.contentType && file.contentType !== 'application/octet-stream'
    ? file.contentType : file.previewType || 'application/octet-stream';
}

// onProgress(fraction) only fires for native saves: a browser download reports progress in its own UI.
export async function downloadFile(file, onProgress) {
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

// Native plugins reject with a plain string; anything without readable text keeps just the summary.
export function downloadFailure(error) {
  const reason = typeof error === 'string' ? error : error?.message;
  return reason ? 'Download failed: ' + reason : 'Download failed.';
}
