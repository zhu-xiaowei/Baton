import { claudeRuntime } from './claude-runtime.mjs';
import { codexRuntime } from './codex-runtime.mjs';
import { normalizeRuntime, registerRuntimeDescriptor } from './session-identity.mjs';
import { killLeftovers } from './turn-process.mjs';

export const runtimeAdapters = [
  claudeRuntime,
  codexRuntime,
];

const adaptersByRuntime = new Map(
  runtimeAdapters.map((adapter) => [adapter.runtime, adapter]),
);

// A runtime beyond claude/codex: a defineRuntimeAdapter object that may also carry `module` (its
// own import.meta.url, default-exporting it, for workers), `catalog`, `history`, `messages`, `watcher`.
export function registerRuntime(adapter) {
  registerRuntimeDescriptor(adapter);
  runtimeAdapters.push(adapter);
  adaptersByRuntime.set(adapter.runtime, adapter);
}

export function getRuntimeAdapter(runtime) {
  const adapter = adaptersByRuntime.get(normalizeRuntime(runtime));
  if (!adapter) throw new Error('unknown_runtime');
  return adapter;
}

// Runtimes whose catalog module (`probe`, with detect()) loads first; the full adapter only when installed.
const INSTALLABLE = [
  { probe: './kiro.mjs', full: './kiro-runtime.mjs' },
];

export async function registerInstalledRuntimes() {
  killLeftovers();
  for (const { probe, full } of INSTALLABLE) {
    try {
      const found = (await import(probe)).detect();
      if (found) registerRuntime((await import(full)).createRuntime(found));
    } catch (error) {
      console.error(`[runtime] ${probe}: ${error.message}`);
    }
  }
}
