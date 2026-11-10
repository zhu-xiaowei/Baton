export const TERMINAL_VIEW_KEY = 'baton-terminal-view';

export function clearTerminalView(storage) {
  try {
    (storage || globalThis.sessionStorage).removeItem(TERMINAL_VIEW_KEY);
  } catch {}
}

export function saveTerminalView(appState, storage) {
  if (!appState?.device || !appState.project?.hash || appState.session === '__new__') {
    clearTerminalView(storage);
    return;
  }
  try {
    (storage || globalThis.sessionStorage).setItem(TERMINAL_VIEW_KEY, JSON.stringify({
      device: appState.device,
      projectHash: appState.project.hash,
      session: appState.session || null,
    }));
  } catch {}
}

export function saveHomeTerminalView(device, projectHash, storage) {
  try {
    (storage || globalThis.sessionStorage).setItem(TERMINAL_VIEW_KEY, JSON.stringify({
      device, projectHash, session: null, home: true,
    }));
  } catch {}
}

export function savedHomeTerminal(appState, storage) {
  let saved = null;
  try {
    saved = JSON.parse((storage || globalThis.sessionStorage).getItem(TERMINAL_VIEW_KEY) || 'null');
  } catch {}
  return saved?.home && appState?.device && !appState.project && saved.device === appState.device
    ? saved.projectHash : null;
}

export function shouldRestoreTerminal(appState, storage) {
  let saved;
  try {
    saved = JSON.parse((storage || globalThis.sessionStorage).getItem(TERMINAL_VIEW_KEY) || 'null');
  } catch {
    clearTerminalView(storage);
    return false;
  }
  const matches = !!saved && !saved.home && !!appState?.device && !!appState.project?.hash
    && saved.device === appState.device
    && saved.projectHash === appState.project.hash
    && saved.session === (appState.session || null)
    && appState.session !== '__new__';
  if (saved && !matches) clearTerminalView(storage);
  return matches;
}
