// Slide decks are converted to PDF by the server; poll until the cached PDF is ready.
const SLIDE_DECK = /\.(pptx?|ppsx?|odp)$/i;
const POLL_MS = 1000;
const TIMEOUT_MS = 150_000;

export function isSlideDeck(name) {
  return SLIDE_DECK.test(name || '');
}

// Start converting right after upload so opening the attachment rarely waits.
export function prefetchSlidePdf(key) {
  if (isSlideDeck(key)) window.apiPost('/api/bridge/file-preview/' + key).catch(() => {});
}

// Resolves { previewUrl, size }, or null once isCurrent() reports the view was replaced.
// onConverting runs once, only when the server is actually converting (never on a cache hit).
export async function waitForSlidePdf(key, isCurrent, onConverting) {
  const started = Date.now();
  let notified = false;
  while (Date.now() - started < TIMEOUT_MS) {
    const result = await window.apiPost('/api/bridge/file-preview/' + key);
    if (!isCurrent()) return null;
    if (result.status === 'ready') return result;
    if (result.status === 'failed') throw new Error(result.error || 'Could not convert this file.');
    if (!notified) { notified = true; onConverting?.(); }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
    if (!isCurrent()) return null;
  }
  throw new Error('Conversion is taking too long. Try again later.');
}
