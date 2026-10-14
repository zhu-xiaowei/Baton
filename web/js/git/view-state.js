export const GIT_STATUS_VIEW_KEY = 'baton-git-status-view';
export const GIT_DIFF_VIEW_KEY = 'baton-git-diff-view';

function viewStorage(storage) {
  return storage || globalThis.sessionStorage;
}

export function clearGitStatusView(storage) {
  try {
    viewStorage(storage).removeItem(GIT_STATUS_VIEW_KEY);
  } catch (error) {}
}

export function saveGitStatusView(appState, storage) {
  var device = appState?.device || '';
  var projectHash = appState?.project?.hash || '';
  var session = appState?.session || null;
  if (!device || !projectHash || session === '__new__') {
    clearGitStatusView(storage);
    return;
  }
  try {
    viewStorage(storage).setItem(GIT_STATUS_VIEW_KEY, JSON.stringify({
      device: device,
      projectHash: projectHash,
      session: session,
    }));
  } catch (error) {}
}

export function shouldRestoreGitStatus(appState, storage) {
  var saved;
  try {
    saved = JSON.parse(viewStorage(storage).getItem(GIT_STATUS_VIEW_KEY) || 'null');
  } catch (error) {
    clearGitStatusView(storage);
    return false;
  }
  var matches = !!saved
    && saved.device === appState?.device
    && saved.projectHash === appState?.project?.hash
    && (saved.session || null) === (appState?.session || null)
    && saved.session !== '__new__';
  if (!matches && saved) clearGitStatusView(storage);
  return matches;
}

export function clearGitDiffView(storage) {
  try {
    viewStorage(storage).removeItem(GIT_DIFF_VIEW_KEY);
  } catch (error) {}
}

export function saveGitDiffView(appState, view, storage) {
  var device = appState?.device || '';
  var projectHash = appState?.project?.hash || '';
  var session = appState?.session || null;
  var path = view?.path || '';
  var group = view?.group || '';
  if (!device || !projectHash || session === '__new__' || !path || !group) {
    clearGitDiffView(storage);
    return;
  }
  try {
    viewStorage(storage).setItem(GIT_DIFF_VIEW_KEY, JSON.stringify({
      device: device,
      projectHash: projectHash,
      session: session,
      path: path,
      group: group,
      status: view.status || '',
      mode: view.mode === 'code' ? 'code' : 'diff',
    }));
  } catch (error) {}
}

export function readGitDiffView(appState, storage) {
  var saved;
  try {
    saved = JSON.parse(viewStorage(storage).getItem(GIT_DIFF_VIEW_KEY) || 'null');
  } catch (error) {
    clearGitDiffView(storage);
    return null;
  }
  var matches = !!saved
    && saved.device === appState?.device
    && saved.projectHash === appState?.project?.hash
    && (saved.session || null) === (appState?.session || null)
    && saved.session !== '__new__'
    && typeof saved.path === 'string'
    && !!saved.path
    && typeof saved.group === 'string'
    && !!saved.group;
  if (!matches) {
    if (saved) clearGitDiffView(storage);
    return null;
  }
  return {
    path: saved.path,
    group: saved.group,
    status: saved.status || '',
    mode: saved.mode === 'code' ? 'code' : 'diff',
  };
}
