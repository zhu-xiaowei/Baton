// The mainland-China relay (bridge/entry.mjs): chosen once per start, again when the network changes or the socket keeps
// failing. The last choice is used at once on the next start while the new one is made.
import { state } from '../state.js';
import { pickEntry, viaEntry, vouched } from '../../../bridge/entry.mjs';

const KEY = 'baton-entry';
const started = new Map(); // server → this start's choice
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

const IP_KEY = 'baton-ip'; // the signed address (bridge/entry.mjs), sent by the next start's first requests
try { vouched.token ||= localStorage.getItem(IP_KEY) || ''; } catch {}

const pick = (server) => pickEntry(server).then((found) => {
  const entry = found === server ? '' : found;
  try { if (vouched.token) localStorage.setItem(IP_KEY, vouched.token); else localStorage.removeItem(IP_KEY); } catch {}
  if (server === state.SERVER) state.ENTRY = entry;
  saved = { server, entry }; // the next start (and the App after pairing) uses it at once
  started.set(server, Promise.resolve(entry)); // a later choice replaces this start's
  try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch {}
  return entry;
});

// This start's choice for `server`, made once (pairing and the first socket share it); '' is the server itself.
export function startEntry(server = state.SERVER) {
  if (!server) return Promise.resolve('');
  if (!started.has(server)) started.set(server, pick(server));
  return started.get(server);
}

// A new choice for state.SERVER (the network changed, the relay may be gone).
export function chooseEntry() {
  if (!state.SERVER) return Promise.resolve();
  return (choosing ||= pick(state.SERVER).finally(() => { choosing = null; }));
}

globalThis.addEventListener?.('online', chooseEntry);
globalThis.navigator?.connection?.addEventListener?.('change', chooseEntry);
