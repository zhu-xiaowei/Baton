const RUNTIME_ORDER = ['claude', 'codex'];

export function creatableRuntimes() {
  return RUNTIME_ORDER.slice();
}

export function preferredNewSessionRuntime(runtimes, savedRuntime) {
  if (runtimes.includes(savedRuntime)) return savedRuntime;
  if (runtimes.includes('claude')) return 'claude';
  return runtimes[0] || null;
}

export function nextNewSessionRuntime(runtimes, currentRuntime) {
  if (runtimes.length < 2) return runtimes[0] || null;
  var index = runtimes.indexOf(currentRuntime);
  return runtimes[(index + 1) % runtimes.length];
}

export function newSessionRuntimePreferenceKey(device) {
  return 'apeek_new_session_runtime:' + String(device || '');
}
