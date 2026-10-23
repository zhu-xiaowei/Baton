import { captureDownloadScope, downloadScopeIsCurrent, requestProjectDownload } from './download-request.js';
import { createDownloadQueue } from './download-queue.js';
import { createDownloadFeedback } from './download-feedback.js';
import { BROWSER_SHARE_MAX_BYTES, browserCanShare, downloadFile, prepareSharedFile } from './download.js';
import { runDownloadStage } from './download-task.js';

function checkScope(scope, signal) {
  signal.throwIfAborted();
  if (!downloadScopeIsCurrent(scope)) throw new Error('Download account or server changed. Open the file again.');
}

export async function executeDownload(target, signal, update) {
  checkScope(target.scope, signal);
  if (target.sharedFile) {
    try {
      await navigator.share({ files: [target.sharedFile] });
      target.sharedFile = null;
      return { status: 'shared' };
    } catch (error) {
      if (error.name === 'AbortError' || error.name === 'NotAllowedError') return { status: 'ready' };
      throw error;
    }
  }
  // A queue task owns its preparation; preview requests cannot be cancelled on its behalf.
  const storedKey = !target.path || target.path.startsWith('baton-file:') ? target.key : null;
  const key = storedKey || (await requestProjectDownload(target, {
    scope: target.scope, signal,
    onProgress: progress => update({ message: progress.stage === 'uploading' ? 'Preparing file…' : 'Preparing download…' }),
  })).key;
  if (typeof key !== 'string' || !key) throw new Error('The device did not return a file to download.');
  checkScope(target.scope, signal);
  const file = await runDownloadStage(stageSignal => window.api('/api/bridge/file-url/' + encodeURIComponent(key),
    target.name ? { name: target.name } : undefined,
    { server: target.scope.server, key: target.scope.accountKey, signal: stageSignal }), { signal });
  checkScope(target.scope, signal);
  update({ state: 'transferring', message: 'Downloading…', progress: null });
  const onProgress = progress => update({ progress, message:
    progress.state === 'connecting' ? 'Connecting…' : progress.state === 'waiting' ? 'Waiting for transfer…' : 'Downloading…' });
  if (browserCanShare() && file.size <= BROWSER_SHARE_MAX_BYTES) {
    try {
      target.sharedFile = await prepareSharedFile(file, onProgress, { signal });
      checkScope(target.scope, signal);
      // Sharing must start from a fresh user gesture after the async file fetch.
      return { status: 'ready' };
    } catch (error) {
      if (error.name !== 'NotSupportedError') throw error;
    }
  }
  checkScope(target.scope, signal);
  return downloadFile(file, onProgress, { signal });
}

const statuses = {
  queued: 'Queued', preparing: 'Preparing download…', transferring: 'Downloading…',
  cancelling: 'Cancelling…', cancelled: 'Cancelled', ready: 'File ready. Tap Share.',
};
const results = {
  saved: 'Saved to Downloads.', queued: 'Added to system Downloads.',
  shared: 'Shared.', started: 'Download started. Use your browser’s Downloads list.',
  share_opened: 'System sharing opened.',
};

export function downloadItemMessage(item) {
  return item.state === 'error' ? String(item.error?.message || item.error) :
    item.state === 'success' ? results[item.result.status] :
      ['preparing', 'transferring'].includes(item.state) ? item.message || statuses[item.state] : statuses[item.state];
}

export function createDownloadManager({ execute = executeDownload, feedback = createDownloadFeedback() } = {}) {
  const queue = createDownloadQueue(execute, (item, event) => {
    const busy = ['queued', 'preparing', 'transferring', 'cancelling'].includes(item.state);
    feedback.show({
      id: item.id, name: item.target.name,
      message: downloadItemMessage(item),
      progress: ['preparing', 'transferring'].includes(item.state) ? item.progress : null,
      result: item.result, busy,
      cancel: busy && item.state !== 'cancelling' ? () => queue.cancel(item.id) : null,
      retry: ['error', 'cancelled', 'ready'].includes(item.state) ? () => queue.retry(item.id) : null,
      notify: event === 'added' || item.state === 'error' || item.state === 'ready',
    });
  });
  return {
    enqueue(target) {
      return queue.enqueue({
        name: target.name, path: target.path, key: target.key,
        device: target.device, projectHash: target.projectHash,
        scope: target.scope || captureDownloadScope(),
      });
    },
    get pending() { return queue.pending; },
    cancelAll: queue.cancelAll,
    retry: queue.retry,
  };
}
