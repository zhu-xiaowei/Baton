export const TERMINAL_VIEW_KEY = 'baton-terminal-view';

const pageOf = appState => [appState.device, appState.project?.hash || null, appState.session || null];

export function clearTerminalView(storage) {
  try {
    (storage || globalThis.sessionStorage).removeItem(TERMINAL_VIEW_KEY);
  } catch {}
}

// `folder` is where the terminal opened; `page` is the page it is shown over.
export function saveTerminalView(appState, storage, folder = appState?.project) {
  if (!appState?.device || !folder?.hash || appState.session === '__new__') {
    clearTerminalView(storage);
    return;
  }
  try {
    (storage || globalThis.sessionStorage).setItem(TERMINAL_VIEW_KEY, JSON.stringify({
      page: pageOf(appState), projectHash: folder.hash, projectName: folder.name || '',
    }));
  } catch {}
}

// The terminal folder to reopen over this page after a refresh, or null.
export function savedTerminalFolder(appState, storage) {
  let saved = null;
  try {
    saved = JSON.parse((storage || globalThis.sessionStorage).getItem(TERMINAL_VIEW_KEY) || 'null');
  } catch {}
  const matches = !!saved?.projectHash && JSON.stringify(saved.page) === JSON.stringify(pageOf(appState || {}));
  if (saved && !matches) clearTerminalView(storage);
  return matches ? { hash: saved.projectHash, name: saved.projectName } : null;
}
