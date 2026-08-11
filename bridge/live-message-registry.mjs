const MAX_LIVE_KEYS = 512;
const pushed = new Set();
const order = [];

function composite(runtime, key) {
  return `${runtime}:${key}`;
}

export function markLiveMessagePushed(runtime, key) {
  if (!runtime || !key) return;
  const value = composite(runtime, key);
  if (pushed.has(value)) return;
  pushed.add(value);
  order.push(value);
  if (order.length > MAX_LIVE_KEYS) pushed.delete(order.shift());
}

export function liveMessagePushed(runtime, key) {
  return !!key && pushed.has(composite(runtime, key));
}

export function clearLiveMessageRegistry() {
  pushed.clear();
  order.length = 0;
}
