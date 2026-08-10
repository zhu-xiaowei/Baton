import { claudeWatcherAdapter, startJobsWatcher } from './watcher.mjs';
import { codexWatcherAdapter } from './codex-watcher.mjs';

export const runtimeWatchers = Object.freeze([
  claudeWatcherAdapter,
  codexWatcherAdapter,
]);

export function startRuntimeWatchers(config, context = {}) {
  const handles = new Map();
  for (const watcher of runtimeWatchers) {
    handles.set(watcher.runtime, watcher.start(config, context));
  }
  startJobsWatcher(config);
  return handles;
}
