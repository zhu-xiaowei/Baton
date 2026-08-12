const MAX_LIVE_KEYS = 512;
const entries = new Map();
const order = [];

function composite(runtime, key) {
  return `${runtime}:${key}`;
}

function entry(runtime, key) {
  if (!runtime || !key) return null;
  const value = composite(runtime, key);
  let current = entries.get(value);
  if (!current) {
    current = { pushed: false, streamId: '' };
    entries.set(value, current);
    order.push(value);
    if (order.length > MAX_LIVE_KEYS) entries.delete(order.shift());
  }
  return current;
}

export function registerLiveMessageStream(runtime, key, streamId) {
  if (!streamId) return;
  const current = entry(runtime, key);
  if (current) current.streamId = streamId;
}

export function liveMessageStream(runtime, key) {
  if (!runtime || !key) return '';
  return entries.get(composite(runtime, key))?.streamId || '';
}

export function markLiveMessagePushed(runtime, key, streamId = '') {
  if (!runtime || !key) return;
  const current = entry(runtime, key);
  current.pushed = true;
  if (streamId) current.streamId = streamId;
}

export function liveMessagePushed(runtime, key) {
  return !!key && !!entries.get(composite(runtime, key))?.pushed;
}

export function clearLiveMessageRegistry() {
  entries.clear();
  order.length = 0;
}
