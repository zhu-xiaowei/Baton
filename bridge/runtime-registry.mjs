import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeRuntime } from './claude-runtime.mjs';
import { codexRuntime } from './codex-runtime.mjs';
import { normalizeRuntime, registerRuntimeDescriptor } from './session-identity.mjs';

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

// Runtimes beyond claude/codex, flat in bridge/: [module, installed]. `installed` must be a cheap
// filesystem check; the module is imported (default-exporting its adapter) only when it passes.
const OPTIONAL_RUNTIMES = [
  ['./dsh-runtime.mjs', () => fs.existsSync(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))],
];

export async function registerInstalledRuntimes(list = OPTIONAL_RUNTIMES) {
  for (const [file, installed] of list) {
    try {
      if (!installed()) continue;
      const adapter = (await import(new URL(file, import.meta.url))).default;
      const discover = adapter.discover.bind(adapter);
      // A store this runtime cannot read must not stop Claude/Codex from syncing.
      registerRuntime({ ...adapter, discover: (options) => {
        try { return discover(options); } catch (error) {
          console.error(`[runtime] ${adapter.runtime} discovery failed: ${error.message}`);
          return { sessions: [] };
        }
      } });
    } catch (error) {
      console.error(`[runtime] ${file} not loaded: ${error.message}`);
    }
  }
}

export function getRuntimeAdapter(runtime) {
  const adapter = adaptersByRuntime.get(normalizeRuntime(runtime));
  if (!adapter) throw new Error('unknown_runtime');
  return adapter;
}
