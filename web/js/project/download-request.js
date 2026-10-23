import { state } from '../state.js';
import { requestProjectFiles } from './rpc.js';

export function captureDownloadScope() {
  return Object.freeze({ server: state.SERVER, accountKey: state.KEY });
}

export function downloadScopeIsCurrent(scope) {
  return scope.server === state.SERVER && scope.accountKey === state.KEY;
}

export async function requestProjectDownload(fields, {
  signal, scope = captureDownloadScope(), onProgress, timeout = 5 * 60_000,
  cancelTimeout = 10_000,
} = {}) {
  signal?.throwIfAborted();
  if (!fields.device || !fields.projectHash) throw new Error('Select a device and project to download');
  const isCurrent = () => downloadScopeIsCurrent(scope);
  if (!isCurrent()) throw new Error('Download account or server changed');
  const target = {
    device: fields.device, projectHash: fields.projectHash, path: fields.path,
    downloadToken: crypto.randomUUID(),
  };
  const local = new AbortController();
  let cancellation;
  const abort = () => {
    if (cancellation) return;
    cancellation = requestProjectFiles('cancel_download', target, { timeout: cancelTimeout, isCurrent });
    cancellation.catch(() => {});
    local.abort(signal.reason || new DOMException('Download cancelled', 'AbortError'));
  };
  const transfer = requestProjectFiles('download', target, {
    signal: local.signal, timeout, onProgress, isCurrent,
  });
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    return await transfer;
  } catch (error) {
    if (!signal?.aborted) throw error;
    try {
      const result = await cancellation;
      if (!result || !['cancelled', 'completed'].includes(result.status)) throw new Error('No cancellation confirmation');
    } catch {
      const unconfirmed = new Error('Cancellation not confirmed; the device may still be preparing the file.');
      unconfirmed.code = 'DOWNLOAD_CANCEL_UNCONFIRMED';
      throw unconfirmed;
    }
    throw signal.reason || new DOMException('Download cancelled', 'AbortError');
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
