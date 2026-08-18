const MAX_LIVE_KEYS = 4096;
const pushedEntries = new Map();
const runtimeOwnedEntries = new Set();

function composite(runtime, key) {
  return `${runtime}:${key}`;
}

function pushedEntry(runtime, key) {
  if (!runtime || !key) return null;
  const value = composite(runtime, key);
  let current = pushedEntries.get(value);
  if (!current) {
    current = { pushed: false };
    pushedEntries.set(value, current);
    while (pushedEntries.size > MAX_LIVE_KEYS) {
      pushedEntries.delete(pushedEntries.keys().next().value);
    }
  }
  return current;
}

export function registerRuntimeOwnedMessage(runtime, key) {
  if (!runtime || !key) return false;
  runtimeOwnedEntries.add(composite(runtime, key));
  return true;
}

export function liveMessageRoute(runtime, key) {
  if (!runtime || !key) return null;
  const value = composite(runtime, key);
  const pushed = !!pushedEntries.get(value)?.pushed;
  const runtimeOwned = runtimeOwnedEntries.has(value);
  return pushed || runtimeOwned ? { pushed, runtimeOwned } : null;
}

export function markLiveMessagePushed(runtime, key) {
  if (!runtime || !key) return false;
  const current = pushedEntry(runtime, key);
  current.pushed = true;
  return true;
}

export function liveMessagePushed(runtime, key) {
  return !!key && !!pushedEntries.get(composite(runtime, key))?.pushed;
}

export function clearLiveMessage(runtime, key) {
  if (!runtime || !key) return false;
  const value = composite(runtime, key);
  const pushed = pushedEntries.delete(value);
  const runtimeOwned = runtimeOwnedEntries.delete(value);
  return pushed || runtimeOwned;
}

export function clearLiveMessageRegistry() {
  pushedEntries.clear();
  runtimeOwnedEntries.clear();
}
