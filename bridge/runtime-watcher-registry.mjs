import { claudeWatcherAdapter, startJobsWatcher } from './watcher.mjs';
import { codexWatcherAdapter } from './codex-watcher.mjs';
import { runtimeDescriptors } from './session-identity.mjs';

export const runtimeWatchers = Object.freeze([
  claudeWatcherAdapter,
  codexWatcherAdapter,
]);

export function startRuntimeWatchers(config, context = {}) {
  const handles = new Map();
  const registered = runtimeDescriptors().map((descriptor) => descriptor.watcher).filter(Boolean);
  for (const watcher of [...runtimeWatchers, ...registered]) {
    handles.set(watcher.runtime, watcher.start(config, context));
  }
  startJobsWatcher(config);
  return handles;
}
