import { state } from '../state.js';
import {
  readProjectDataCache,
  writeProjectDataCache,
} from '../cache/project-data-cache.js';
import { registerEdgeBackLayer } from '../edge-back.js';
import { confirmDiscard } from './discard-confirm.js';
import {
  closeGitDiff,
  openGitDiff,
  restoreGitDiffView,
} from './diff-viewer.js';
import { mountCommitBar, updateCommitBar } from './commit-bar.js';
import { mountGitHistory, refreshGitHistory, updateGitHistorySnapshot } from './history.js';
import {
  closeGitPage,
  gitCommitBarContent,
  gitContent,
  gitHistoryContent,
  gitScrollContent,
  openGitPage,
  renderGitHeader,
  setGitLoading,
} from './page.js';
import { requestGit } from './rpc.js';
import { renderGitStatus } from './status-render.js';
import { clearGitStatusView, saveGitStatusView } from './view-state.js';

var snapshot = null;
var snapshotProject = '';
var snapshotCache = new Map();
var version = 0;
var busy = false;
var statusRequest = null;
var collapsed = new Set();
var returnToFiles = false;
var edgeBack = registerEdgeBackLayer({
  navigateBack: closeGitStatus,
  foregroundSelectors: ['#gitStatusPage'],
  underlaySelectors: function () {
    return returnToFiles ? ['#projectFilesPage'] : [];
  },
  guardZIndex: 902,
  foregroundZIndex: 900,
});

function projectHash() { return state.appState.project?.hash || ''; }
function projectName() { return state.appState.project?.name || 'Project'; }

function snapshotCacheKey() {
  return JSON.stringify([state.SERVER, state.appState.device || '', projectHash()]);
}

function snapshotCacheFields() {
  return {
    server: state.SERVER,
    device: state.appState.device || '',
    projectHash: projectHash(),
    type: 'git',
    path: '',
  };
}

function cacheSnapshot(value) {
  if (!value) return;
  var key = snapshotCacheKey();
  snapshot = value;
  snapshotProject = key;
  snapshotCache.set(key, value);
  writeProjectDataCache(snapshotCacheFields(), value);
}

async function hydrateSnapshot() {
  var key = snapshotCacheKey();
  if (snapshotCache.has(key)) return snapshotCache.get(key);
  var record = await readProjectDataCache(snapshotCacheFields());
  if (!record?.data
    || !state.gitStatusOpen
    || snapshotCacheKey() !== key) return null;
  snapshotCache.set(key, record.data);
  if (snapshotProject !== key) {
    snapshot = record.data;
    snapshotProject = key;
    render();
  }
  return record.data;
}

function entryFor(path, group) {
  return snapshot?.groups?.[group]?.find(function (entry) { return entry.path === path; });
}

function render(error) {
  renderGitHeader(projectName(), snapshot?.repository);
  updateCommitBar(snapshot);
  updateGitHistorySnapshot(snapshot);
  renderGitStatus(gitContent(), snapshot, {
    busy: busy,
    error: error,
    collapsed: collapsed,
    onToggle: function (group) {
      if (collapsed.has(group)) collapsed.delete(group); else collapsed.add(group);
      render();
    },
    onMutation: mutate,
    onDiff: function (path, group) {
      openGitDiff(path, group, entryFor(path, group)?.status);
    },
  });
}

export async function refreshGitStatus() {
  if (!state.gitStatusOpen || busy) return;
  var currentProject = projectHash();
  if (statusRequest
    && statusRequest.projectHash === currentProject
    && statusRequest.version === version) {
    return statusRequest.promise;
  }
  var myVersion = ++version;
  setGitLoading(true);
  var request = {
    projectHash: currentProject,
    version: myVersion,
    promise: null,
  };
  request.promise = (async function () {
    try {
    var result = await requestGit('status', { projectHash: projectHash() });
    if (!state.gitStatusOpen || myVersion !== version) return;
    cacheSnapshot(result);
    render();
    } catch (error) {
    if (state.gitStatusOpen && myVersion === version) render(error.message);
    } finally {
    if (state.gitStatusOpen && myVersion === version) setGitLoading(false);
      if (statusRequest === request) statusRequest = null;
    }
  })();
  statusRequest = request;
  return request.promise;
}

async function mutate(spec, confirmed = false) {
  if (busy || !snapshot) return;
  var all = !spec.path;
  var entries = snapshot.groups?.[spec.group] || [];
  if (spec.operation === 'discard' && !confirmed) {
    var discardSpec = { ...spec, snapshotId: snapshot.snapshotId };
    var untracked = all
      ? entries.some(function (entry) { return entry.status === 'untracked'; })
      : entryFor(spec.path, spec.group)?.status === 'untracked';
    await confirmDiscard({ all: all, count: all ? entries.length : 1, path: spec.path, untracked: untracked,
      onConfirm: function () { return mutate(discardSpec, true); } });
    return;
  }
  busy = true;
  setGitLoading(true);
  render();
  try {
    var result = await requestGit(spec.operation, {
      projectHash: projectHash(),
      group: spec.group,
      ...(all ? { all: true, snapshotId: confirmed ? spec.snapshotId : snapshot.snapshotId } : { path: spec.path }),
    });
    cacheSnapshot(result);
    render();
  } catch (error) {
    if (error.response?.groups) snapshot = error.response;
    render(error.message);
    if (confirmed) throw error;
  } finally {
    busy = false;
    setGitLoading(false);
    render();
  }
}

export function openGitStatus(options) {
  if (!state.appState.project) return;
  options = options || {};
  returnToFiles = !!options.returnToFiles;
  state.gitStatusOpen = true;
  saveGitStatusView(state.appState);
  collapsed = new Set();
  edgeBack.activate();
  openGitPage({
    onBack: closeGitStatus,
    onRefresh: refreshAll,
    onFiles: function () {
      if (returnToFiles) {
        closeGitStatus();
        return;
      }
      deactivateGitStatus(true);
      window.openProjectFilesFromGit?.();
    },
  });
  var cacheKey = snapshotCacheKey();
  mountGitHistory({
    container: gitHistoryContent(),
    scroller: gitScrollContent(),
    projectHash: projectHash(),
    projectKey: cacheKey,
  });
  mountCommitBar({
    container: gitCommitBarContent(),
    projectHash: projectHash(),
    projectKey: cacheKey,
    onSnapshot: function (value) {
      cacheSnapshot(value);
      render();
    },
    onPushed: refreshGitHistory,
  });
  var memorySnapshot = snapshotCache.get(cacheKey);
  if (memorySnapshot) {
    snapshot = memorySnapshot;
    snapshotProject = cacheKey;
    render();
  } else if (snapshotProject === cacheKey && snapshot) render();
  else {
    snapshot = null;
    render();
  }
  var hydratePromise = hydrateSnapshot();
  window.loadViewerLibs().then(async function () {
    await hydratePromise;
    if (!state.gitStatusOpen) return;
    window.connectWs();
    restoreGitDiffView();
    refreshGitStatus();
  });
}

function refreshAll() {
  refreshGitStatus();
  refreshGitHistory();
}

export function closeGitStatus() {
  if (returnToFiles) {
    returnToFiles = false;
    deactivateGitStatus(true);
    window.resumeProjectFilesFromGit?.();
    return true;
  }
  return deactivateGitStatus(false);
}

export function deactivateGitStatus(keepWs) {
  if (!state.gitStatusOpen) return false;
  state.gitStatusOpen = false;
  closeGitDiff();
  clearGitStatusView();
  version++;
  edgeBack.deactivate();
  closeGitPage();
  if (!keepWs) returnToFiles = false;
  if (!keepWs && !state.wsSessionId) window.disconnectWs?.();
  return true;
}

Object.assign(window, {
  openGitStatus: openGitStatus,
  closeGitStatus: closeGitStatus,
  deactivateGitStatus: deactivateGitStatus,
  refreshGitStatus: refreshGitStatus,
  refreshGitStatusOnReconnect: function () {
    if (state.gitStatusOpen) refreshAll();
  },
});
