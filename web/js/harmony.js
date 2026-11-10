// HarmonyOS NEXT shell: every native call goes through window.harmonyBridge
// (harmony/.../bridge/NativeBridge.ets); every reply and pushed event arrives
// on window.__onHarmony (harmony/.../bridge/JsChannel.ets).
let nextId = 0;
const pending = new Map();
const eventHandlers = new Set();

export function harmonyBridge() {
  const bridge = typeof window === 'undefined' ? null : window.harmonyBridge;
  return bridge && typeof bridge.download === 'function' ? bridge : null;
}

function install(host) {
  if (host.__onHarmony) return;
  host.__onHarmony = message => {
    if (!message) return;
    if (message.event) {
      for (const handler of Array.from(eventHandlers)) handler(message);
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    if (message.progress !== undefined) {
      entry.onProgress?.(message.progress);
      return;
    }
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error));
    else entry.resolve(message.result);
  };
}

// Resolves with the native result; onProgress(fraction) receives download progress.
export function harmonyCall(method, args = {}, onProgress) {
  const bridge = harmonyBridge();
  if (!bridge || typeof bridge[method] !== 'function') {
    return Promise.reject(new Error(`${method} is unavailable`));
  }
  install(window);
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    try {
      bridge[method](JSON.stringify({ id, ...args }));
    } catch {
      pending.delete(id);
      reject(new Error(`${method} is unavailable`));
    }
  });
}

// Fire-and-forget: the native side sends no reply.
export function harmonySend(method, args = {}) {
  const bridge = harmonyBridge();
  if (!bridge || typeof bridge[method] !== 'function') throw new Error(`${method} is unavailable`);
  bridge[method](JSON.stringify(args));
}

export function onHarmonyEvent(handler) {
  install(window);
  eventHandlers.add(handler);
  return () => eventHandlers.delete(handler);
}
