import { state } from '../state.js';
import {
  readProjectDataCache,
  writeProjectDataCache,
} from '../cache/project-data-cache.js';
import { registerEdgeBackLayer } from '../edge-back.js';
import { fileIconHtml } from '../components/file-icon.js';
import { FOLDER_ICON_SVG } from '../components/icons.js';
import { requestProjectFiles } from './rpc.js';
import {
  joinProjectPath,
  normalizeProjectPath,
  projectBreadcrumbItems,
} from './paths.js';
import {
  closeProjectFilesPage,
  openProjectFilesPage,
  projectFilesContent,
  renderProjectFilesBreadcrumb,
  setProjectFilesLoading,
} from './page.js';

var currentPath = '';
var navigationVersion = 0;
var returnToGit = false;
var PROJECT_FILES_VIEW_KEY = 'baton-project-files-view';
var directoryCache = new Map();
var pendingDirectories = new Map();
var preloads = { queue: new Map(), active: 0 };
var visibilityObserver = null;
// A directory fetched this recently (usually by a visible-row preload) opens without another request.
var FRESH_DIRECTORY_MS = 30000;
var edgeBack = registerEdgeBackLayer({
  navigateBack: closeProjectFiles,
  foregroundSelectors: ['#projectFilesPage'],
  underlaySelectors: function () {
    return returnToGit ? ['#gitStatusPage'] : [];
  },
  guardZIndex: 902,
  foregroundZIndex: 900,
});

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function projectName() {
  return state.appState.project?.name || 'Project';
}

function directoryCacheKey(projectHash, path) {
  return JSON.stringify([
    state.SERVER,
    state.appState.device || '',
    projectHash,
    path,
  ]);
}

function cachedDirectory(projectHash, path) {
  return directoryCache.get(directoryCacheKey(projectHash, path)) || null;
}

function persistentDirectoryFields(projectHash, path) {
  return {
    server: state.SERVER,
    device: state.appState.device || '',
    projectHash: projectHash,
    type: 'files',
    path: path,
  };
}

function cacheDirectory(projectHash, path, entries, scrollTop, options) {
  options = options || {};
  var key = directoryCacheKey(projectHash, path);
  directoryCache.set(key, {
    entries: entries.slice(),
    scrollTop: Math.max(0, scrollTop || 0),
    fetchedAt: directoryCache.get(key)?.fetchedAt || 0,
  });
  if (options.persist !== false) {
    writeProjectDataCache(
      persistentDirectoryFields(projectHash, path),
      { entries: entries },
      { scrollTop: scrollTop },
    );
  }
}

function rememberDirectoryScroll() {
  if (!state.projectFilesOpen || !state.appState.project) return;
  var cached = cachedDirectory(state.appState.project.hash, currentPath);
  if (!cached) return;
  cached.scrollTop = projectFilesContent().scrollTop;
  writeProjectDataCache(
    persistentDirectoryFields(state.appState.project.hash, currentPath),
    { entries: cached.entries },
    { scrollTop: cached.scrollTop },
  );
}

function saveProjectFilesView() {
  try {
    sessionStorage.setItem(PROJECT_FILES_VIEW_KEY, JSON.stringify({
      device: state.appState.device,
      projectHash: state.appState.project?.hash || '',
      path: currentPath,
    }));
  } catch (error) {}
}

function clearProjectFilesView() {
  try { sessionStorage.removeItem(PROJECT_FILES_VIEW_KEY); } catch (error) {}
}

function restoreProjectFilesView() {
  let saved;
  try {
    saved = JSON.parse(sessionStorage.getItem(PROJECT_FILES_VIEW_KEY) || 'null');
  } catch (error) {
    clearProjectFilesView();
    return false;
  }
  if (!saved
    || saved.device !== state.appState.device
    || saved.projectHash !== state.appState.project?.hash
    || state.appState.session) {
    if (saved) clearProjectFilesView();
    return false;
  }
  openProjectFilesPath(saved.path || '');
  return true;
}

function rowHtml(entry) {
  var iconHtml = entry.type === 'directory'
    ? FOLDER_ICON_SVG
    : fileIconHtml(entry.name);
  return '<button class="project-file-row" type="button" data-name="'
    + escapeHtml(entry.name) + '" data-type="' + escapeHtml(entry.type) + '">'
    + '<span class="project-file-icon ' + escapeHtml(entry.type) + '">'
    + iconHtml + '</span>'
    + '<span class="project-file-name">' + escapeHtml(entry.name) + '</span>'
    + (entry.type === 'directory'
      ? '<span class="project-file-chevron" aria-hidden="true">›</span>'
      : '')
    + '</button>';
}

function renderEntries(entries) {
  var content = projectFilesContent();
  if (!entries.length) {
    stopVisiblePreloads();
    content.innerHTML = '<div class="empty">This folder is empty</div>';
    return;
  }
  content.innerHTML = '<div class="project-file-list">'
    + entries.map(rowHtml).join('') + '</div>';
  content.querySelectorAll('.project-file-row').forEach(function (row) {
    row.addEventListener('click', function () {
      var nextPath = joinProjectPath(currentPath, row.dataset.name || '');
      if (row.dataset.type === 'directory') {
        openProjectFilesPath(nextPath);
      } else if (window.openFile) {
        window.openFile(nextPath, row.dataset.name || nextPath);
      }
    });
  });
  observeVisibleDirectories(content);
}

// Concurrent callers share one request; the result lands in the memory cache only.
function fetchDirectory(projectHash, path, onPage) {
  var key = directoryCacheKey(projectHash, path);
  if (pendingDirectories.has(key)) return pendingDirectories.get(key);
  var promise = (async function () {
    await window.loadViewerLibs();
    var entries = [];
    var cursor = '';
    do {
      var response = await requestProjectFiles('list', {
        projectHash: projectHash,
        path: path,
        cursor: cursor,
      });
      entries = entries.concat(response.entries || []);
      cursor = response.nextCursor || '';
      onPage?.(entries);
    } while (cursor);
    directoryCache.set(key, {
      entries: entries.slice(),
      scrollTop: directoryCache.get(key)?.scrollTop || 0,
      fetchedAt: Date.now(),
    });
    return entries;
  })().finally(function () {
    pendingDirectories.delete(key);
  });
  pendingDirectories.set(key, promise);
  return promise;
}

function stopVisiblePreloads() {
  visibilityObserver?.disconnect();
  visibilityObserver = null;
  preloads.queue.clear();
}

function runPreloads() {
  while (preloads.active < 4 && preloads.queue.size) {
    var [key, path] = preloads.queue.entries().next().value;
    preloads.queue.delete(key);
    if (directoryCache.has(key) || pendingDirectories.has(key)) continue;
    preloads.active++;
    fetchDirectory(state.appState.project?.hash || '', path).catch(function () {}).finally(function () {
      preloads.active--;
      runPreloads();
    });
  }
}

function observeVisibleDirectories(content) {
  stopVisiblePreloads();
  if (!window.IntersectionObserver) return;
  var projectHash = state.appState.project?.hash || '';
  var directory = currentPath;
  var observer = new window.IntersectionObserver(function (entries) {
    if (visibilityObserver !== observer) return;
    for (var entry of entries) {
      var path = joinProjectPath(directory, entry.target.dataset.name || '');
      var key = directoryCacheKey(projectHash, path);
      if (!entry.isIntersecting) preloads.queue.delete(key);
      else if (!directoryCache.has(key) && !pendingDirectories.has(key)) preloads.queue.set(key, path);
    }
    runPreloads();
  }, { root: content });
  visibilityObserver = observer;
  content.querySelectorAll('.project-file-row[data-type="directory"]').forEach(function (row) {
    observer.observe(row);
  });
}

async function loadDirectory(version, options) {
  options = options || {};
  var projectHash = state.appState.project?.hash || '';
  var path = options.path == null ? currentPath : options.path;
  var current = function () {
    return state.projectFilesOpen && version === navigationVersion;
  };
  var rendered = null;
  var entries = await fetchDirectory(projectHash, path, options.deferRender ? null : function (page) {
    if (!current()) return;
    rendered = page;
    renderEntries(page);
  });
  if (!current()) return;
  if (rendered !== entries) renderEntries(entries);
  cacheDirectory(projectHash, path, entries, options.scrollTop);
  return entries;
}

export async function openProjectFilesPath(path) {
  if (!state.appState.project) return;
  rememberDirectoryScroll();
  currentPath = normalizeProjectPath(path);
  stopVisiblePreloads();
  var projectHash = state.appState.project.hash;
  var cached = cachedDirectory(projectHash, currentPath);
  saveProjectFilesView();
  state.projectFilesOpen = true;
  edgeBack.activate();
  openProjectFilesPage({
    onBack: closeProjectFiles,
    onNavigate: openProjectFilesPath,
    onGit: function () {
      var returning = returnToGit;
      returnToGit = false;
      deactivateProjectFiles(true);
      window.openGitStatusPage?.(returning ? {} : { returnToFiles: true });
    },
  });
  navigationVersion++;
  var version = navigationVersion;
  renderProjectFilesBreadcrumb(projectBreadcrumbItems(projectName(), currentPath));
  var content = projectFilesContent();
  if (cached && Date.now() - cached.fetchedAt < FRESH_DIRECTORY_MS) {
    setProjectFilesLoading(false);
    renderEntries(cached.entries);
    content.scrollTop = cached.scrollTop;
    cacheDirectory(projectHash, currentPath, cached.entries, cached.scrollTop);
    return;
  }
  setProjectFilesLoading(true);
  if (cached) {
    renderEntries(cached.entries);
    content.scrollTop = cached.scrollTop;
  } else {
    content.innerHTML = '';
    content.scrollTop = 0;
  }
  var viewerPromise = window.loadViewerLibs();
  if (!cached) {
    var persisted = await readProjectDataCache(
      persistentDirectoryFields(projectHash, currentPath),
    );
    if (!state.projectFilesOpen || version !== navigationVersion) return;
    if (persisted?.data?.entries) {
      cached = {
        entries: persisted.data.entries,
        scrollTop: persisted.scrollTop || 0,
      };
      cacheDirectory(
        projectHash,
        currentPath,
        cached.entries,
        cached.scrollTop,
        { persist: false },
      );
      renderEntries(cached.entries);
      content.scrollTop = cached.scrollTop;
    }
  }
  await viewerPromise;
  if (!state.projectFilesOpen || version !== navigationVersion) return;
  window.connectWs();
  try {
    var entries = await loadDirectory(version, {
      path: currentPath,
      deferRender: !!cached,
      scrollTop: cached?.scrollTop || 0,
    });
    if (cached && entries && state.projectFilesOpen && version === navigationVersion) {
      content.scrollTop = Math.min(
        cached.scrollTop,
        Math.max(0, content.scrollHeight - content.clientHeight),
      );
      rememberDirectoryScroll();
    }
  } catch (error) {
    if (!state.projectFilesOpen || version !== navigationVersion) return;
    if (!cached) {
      content.innerHTML = '<div class="empty">Unable to load files<br><br>'
        + '<span class="project-files-error">' + escapeHtml(error.message) + '</span></div>';
    }
  } finally {
    if (state.projectFilesOpen && version === navigationVersion) {
      setProjectFilesLoading(false);
    }
  }
}

export async function refreshProjectFiles() {
  if (!state.projectFilesOpen) return false;
  var path = currentPath;
  var content = projectFilesContent();
  var scrollTop = content.scrollTop;
  var version = ++navigationVersion;
  setProjectFilesLoading(true);
  try {
    await window.loadViewerLibs();
    if (!state.projectFilesOpen || version !== navigationVersion) return false;
    window.connectWs();
    var entries = await loadDirectory(version, {
      path: path,
      deferRender: true,
      scrollTop: scrollTop,
    });
    if (!entries || !state.projectFilesOpen || version !== navigationVersion) return false;
    content.scrollTop = Math.min(
      scrollTop,
      Math.max(0, content.scrollHeight - content.clientHeight),
    );
    rememberDirectoryScroll();
    return true;
  } catch (error) {
    return false;
  } finally {
    if (state.projectFilesOpen && version === navigationVersion) {
      setProjectFilesLoading(false);
    }
  }
}

export function openProjectFiles() {
  returnToGit = false;
  return openProjectFilesPath('');
}

export function closeProjectFiles() {
  if (!state.projectFilesOpen) return false;
  var returning = returnToGit;
  returnToGit = false;
  deactivateProjectFiles(returning);
  if (returning) window.openGitStatusPage?.();
  return true;
}

export function openProjectFilesFromGit() {
  returnToGit = true;
  return openProjectFilesPath('');
}

export function resumeProjectFilesFromGit() {
  returnToGit = false;
  return openProjectFilesPath(currentPath);
}

export function deactivateProjectFiles(keepWs) {
  if (!state.projectFilesOpen) return false;
  state.projectFilesOpen = false;
  clearProjectFilesView();
  stopVisiblePreloads();
  navigationVersion++;
  edgeBack.deactivate();
  closeProjectFilesPage();
  if (!keepWs) returnToGit = false;
  if (!keepWs && !state.wsSessionId) window.disconnectWs?.();
  return true;
}

export function projectFilesBack() {
  return closeProjectFiles();
}

Object.assign(window, {
  openProjectFiles: openProjectFiles,
  openProjectFilesPath: openProjectFilesPath,
  openProjectFilesFromGit: openProjectFilesFromGit,
  resumeProjectFilesFromGit: resumeProjectFilesFromGit,
  refreshProjectFiles: refreshProjectFiles,
  closeProjectFiles: closeProjectFiles,
  deactivateProjectFiles: deactivateProjectFiles,
  projectFilesBack: projectFilesBack,
});

queueMicrotask(function () {
  if (state.appState.project && !state.appState.session) {
    window.updateBreadcrumb?.();
    restoreProjectFilesView();
  }
});
