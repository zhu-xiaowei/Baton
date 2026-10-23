export function downloadCancelled() {
  return new DOMException('Download cancelled', 'AbortError');
}

// Abort the underlying request as well as ending the wait for its result.
export async function runDownloadStage(task, { signal, timeout = 30_000, message } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason || downloadCancelled());
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(message || 'Download request timed out. Try again.')), timeout);
  let onAbort;
  try {
    controller.signal.throwIfAborted();
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    return await Promise.race([task(controller.signal), cancelled]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
