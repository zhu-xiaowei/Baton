import { state } from '../state.js';
import { closeFileViewer, openFile } from '../project/file-viewer.js';
import { requestGitDiff } from './rpc.js';
import {
  clearGitDiffView,
  readGitDiffView,
  saveGitDiffView,
} from './view-state.js';

var current;

export function openGitDiff(path, group, status, options) {
  var view = { path: path, group: group, status: status || '' };
  var projectHash = state.appState.project?.hash || '';
  var opened = openFile(path, path.split('/').pop(), '', '', {
    projectHash: projectHash,
    canRead: status !== 'deleted',
    mode: options?.mode === 'code' && status !== 'deleted' ? 'source' : 'diff',
    loadDiff: function () {
      return requestGitDiff({ projectHash: projectHash, group: group, path: path });
    },
    onModeChange: function (mode) {
      view.mode = mode === 'diff' ? 'diff' : 'code';
      saveGitDiffView(state.appState, view);
    },
    onClose: function (closeOptions) {
      current = null;
      clearGitDiffView();
      if (closeOptions.refresh !== false && state.gitStatusOpen) window.refreshGitStatus?.();
    },
  });
  if (opened) current = view;
}

export function closeGitDiff() {
  clearGitDiffView();
  if (!current) return false;
  return closeFileViewer();
}

export function restoreGitDiffView() {
  var saved = readGitDiffView(state.appState);
  if (!saved) return false;
  openGitDiff(saved.path, saved.group, saved.status, { mode: saved.mode });
  return true;
}
