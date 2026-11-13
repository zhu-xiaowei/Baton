import fs from 'fs';
import os from 'os';
import path from 'path';
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

export function getRuntimeAdapter(runtime) {
  const adapter = adaptersByRuntime.get(normalizeRuntime(runtime));
  if (!adapter) throw new Error('unknown_runtime');
  return adapter;
}

// Optional runtimes: [installed?, module], the module imported only when its harness is installed.
const OPTIONAL_RUNTIMES = [
  [() => fs.existsSync(path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'opencode/opencode.db')),
    () => import('./opencode-runtime.mjs')],
];

export async function registerInstalledRuntimes() {
  for (const [installed, load] of OPTIONAL_RUNTIMES) {
    try {
      if (installed()) registerRuntime((await load()).default);
    } catch (error) {
      console.error(`[runtime] ${error.message}`);
    }
  }
}
