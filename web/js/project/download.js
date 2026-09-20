export function nativeDownloads() {
  return !!window.__TAURI_INTERNALS__;
}

export function browserCanShare() {
  return !nativeDownloads() && typeof window.navigator.share === 'function' && typeof window.navigator.canShare === 'function';
}

function contentType(file) {
  return file.contentType && file.contentType !== 'application/octet-stream'
    ? file.contentType : file.previewType || 'application/octet-stream';
}

export async function downloadFile(file) {
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
  const maxBytes = 50 * 1024 * 1024;
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
  if (!navigator.canShare({ files: [shared] })) throw new Error('This browser cannot share this file type. Use Download instead.');
  return shared;
}
