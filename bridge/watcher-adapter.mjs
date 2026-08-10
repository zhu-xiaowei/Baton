export function defineRuntimeWatcher(definition) {
  if (!definition?.runtime || typeof definition.runtime !== 'string') {
    throw new TypeError('runtime watcher requires a runtime id');
  }
  if (typeof definition.start !== 'function') {
    throw new TypeError(`${definition.runtime} runtime watcher requires start()`);
  }
  return Object.freeze(definition);
}
