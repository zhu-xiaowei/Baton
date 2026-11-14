import { claudeWatcherAdapter, startJobsWatcher } from './watcher.mjs';
import { codexWatcherAdapter } from './codex-watcher.mjs';
import { runtimeDescriptors } from './session-identity.mjs';

export const runtimeWatchers = Object.freeze([
  claudeWatcherAdapter,
  codexWatcherAdapter,
]);

let startedConfig = null; // a runtime registered later starts with the same config

export function startRuntimeWatchers(config, context = {}) {
  startedConfig = config;
  const handles = new Map();
  const registered = runtimeDescriptors().map((descriptor) => descriptor.watcher).filter(Boolean);
  for (const watcher of [...runtimeWatchers, ...registered]) startRuntimeWatcher(watcher, config, context, handles);
  startJobsWatcher(config);
  return handles;
}

// One runtime's watcher failing to start must not stop the others.
export function startRuntimeWatcher(watcher, config = startedConfig, context = {}, handles = new Map()) {
  try { handles.set(watcher.runtime, watcher.start(config, context)); } catch (error) {
    console.error(`[watcher] ${watcher.runtime} not started: ${error.message}`);
  }
}
