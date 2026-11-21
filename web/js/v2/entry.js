// The mainland-China relay (bridge/entry.mjs): chosen once per start, again when the network changes or the socket keeps
// failing. The last choice is used at once on the next start while the new one is made.
import { state } from '../state.js';
import { pickEntry, viaEntry } from '../../../bridge/entry.mjs';

const KEY = 'baton-entry';
let saved, choosing;

// The entry for state.SERVER: '' is the API host itself, undefined not chosen yet.
function current() {
  if (state.ENTRY !== undefined) return state.ENTRY;
  try { saved ??= JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { saved = {}; }
  return saved.server === state.SERVER ? saved.entry : undefined;
}

export const entryUrl = (url) => viaEntry(url, state.SERVER, current());
export const hasEntry = () => !!current(); // a relay
export const entryKnown = () => current() !== undefined;

export function chooseEntry() {
  if (!state.SERVER) return Promise.resolve();
  const server = state.SERVER;
  return (choosing ||= pickEntry(server).then((entry) => {
    if (server !== state.SERVER) return;
    state.ENTRY = entry === server ? '' : entry;
    try { localStorage.setItem(KEY, JSON.stringify({ server, entry: state.ENTRY })); } catch {}
  }).finally(() => { choosing = null; }));
}

globalThis.addEventListener?.('online', chooseEntry);
globalThis.navigator?.connection?.addEventListener?.('change', chooseEntry);
