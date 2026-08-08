import { claudeRuntime } from './claude-runtime.mjs';
import { codexRuntime } from './codex-runtime.mjs';
import { normalizeRuntime } from './session-identity.mjs';

export const runtimeAdapters = Object.freeze([
  claudeRuntime,
  codexRuntime,
]);

const adaptersByRuntime = new Map(
  runtimeAdapters.map((adapter) => [adapter.runtime, adapter]),
);

export function getRuntimeAdapter(runtime) {
  return adaptersByRuntime.get(normalizeRuntime(runtime)) || claudeRuntime;
}

export function detectRegisteredRuntimeCapabilities(runtimeOptions = {}) {
  return Object.fromEntries(
    runtimeAdapters.map((adapter) => [
      adapter.runtime,
      adapter.detectCapability(runtimeOptions[adapter.runtime] || {}),
    ]),
  );
}
