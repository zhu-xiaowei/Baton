import { state } from '../state.js';
import { FOLDER_ICON_SVG } from '../components/icons.js';
import { loadingSpinner } from '../components/loading.js';
import { requestProjectFiles } from './rpc.js';

let navigationVersion = 0;
let inputTimer;
let currentDirectory;
let directoryCache = new Map();
let visibilityObserver;
const preloads = { queue: new Map(), active: 0 };

function elements() {
  const modal = document.getElementById('newProjectModal');
  return {
    input: document.getElementById('newProjectInput'),
    list: document.getElementById('newProjectDirectories'),
    up: document.getElementById('newProjectUp'),
    error: document.getElementById('newProjectError'),
    create: modal.querySelector('.modal-btn.confirm'),
  };
}

function joinDirectoryPath(directory, name) {
  const separator = directory.startsWith('/') ? '/' : '\\';
  return directory + (directory.endsWith(separator) ? '' : separator) + name;
}

function setPathInput(input, value) {
  input.value = value;
  input.setSelectionRange(value.length, value.length);
  input.scrollLeft = input.scrollWidth;
}

function splitDirectoryInput(value) {
  const index = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  const prefix = value === '~' ? '' : value.slice(index + 1);
  return { prefix, path: prefix ? value.slice(0, index + 1) : value };
}

function directoryKey(value, context = [state.SERVER, state.appState.device]) {
  const normalized = value && (/^[a-z]:[/\\]$/i.test(value) ? value : value.replace(/[/\\]+$/, '') || '/');
  return JSON.stringify([...context, normalized]);
}

function loadDirectory(value) {
  const cache = directoryCache;
  const context = [state.SERVER, state.appState.device];
  const key = directoryKey(value, context);
  preloads.queue.delete(key);
  if (cache.has(key)) return cache.get(key);
  const entry = {};
  cache.set(key, entry);
  entry.promise = (async () => {
    await window.loadViewerLibs();
    if (cache !== directoryCache) return;
    let cursor = '';
    let entries = [];
    let response;
    do {
      response = await requestProjectFiles('browse', { path: value, cursor }, { timeout: 10000 });
      entries = entries.concat(response.entries || []);
      cursor = response.nextCursor || '';
    } while (cursor && cache === directoryCache);
    const result = { ...response, entries };
    if (response.exists) {
      entry.result = result;
      cache.set(directoryKey(response.targetPath, context), entry);
      if (!value) cache.set(directoryKey('~', context), entry);
    } else {
      cache.delete(key);
    }
    return result;
  })().catch(error => {
    cache.delete(key);
    throw error;
  });
  return entry;
}

function runPreloads() {
  while (preloads.active < 4 && preloads.queue.size) {
    const [key, value] = preloads.queue.entries().next().value;
    preloads.queue.delete(key);
    if (directoryCache.has(key) || directoryKey(value) !== key) continue;
    preloads.active++;
    loadDirectory(value).promise.catch(() => {}).finally(() => {
      preloads.active--;
      runPreloads();
    });
  }
}

function preloadDirectory(value) {
  const key = directoryKey(value);
  if (directoryCache.has(key)) return;
  preloads.queue.set(key, value);
  runPreloads();
}

function stopVisiblePreloads() {
  visibilityObserver?.disconnect();
  visibilityObserver = null;
  preloads.queue.clear();
}

function observeVisibleDirectories(list) {
  if (!window.IntersectionObserver) return;
  const observer = new window.IntersectionObserver(entries => {
    if (visibilityObserver !== observer) return;
    for (const entry of entries) {
      const value = entry.target.dataset.path;
      if (entry.isIntersecting) preloadDirectory(value);
      else preloads.queue.delete(directoryKey(value));
    }
  }, { root: list });
  visibilityObserver = observer;
  list.querySelectorAll('.project-file-row').forEach(row => observer.observe(row));
}

function renderDirectories(list, entries, directory, prefix = '', newFolder = false) {
  entries = newFolder && !prefix ? [] : entries
    .filter(entry => entry.name.toLowerCase().startsWith(prefix.toLowerCase()))
    .sort((left, right) => Number(left.name.startsWith('.')) - Number(right.name.startsWith('.'))
      || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }));
  list.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'new-project-empty';
    empty.setAttribute('role', 'status');
    empty.textContent = newFolder ? 'Will create this folder' : prefix ? 'No matching folders' : 'No folders';
    list.append(empty);
  }
  for (const entry of entries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'project-file-row';
    button.innerHTML = '<span class="project-file-icon directory">' + FOLDER_ICON_SVG + '</span>';
    const name = document.createElement('span');
    name.className = 'project-file-name';
    name.textContent = entry.name;
    button.append(name);
    const targetPath = joinDirectoryPath(directory, entry.name);
    button.dataset.path = targetPath;
    button.addEventListener('click', () => {
      browseNewProjectPath(targetPath);
    });
    list.append(button);
  }
  observeVisibleDirectories(list);
}

export async function browseNewProjectPath(value, preserveInput = false) {
  if (state._pendingCreatePath) return;
  clearTimeout(inputTimer);
  const version = ++navigationVersion;
  const ui = elements();
  const requestedPath = value == null ? ui.input.value.trim() : value;
  if (!preserveInput && requestedPath) setPathInput(ui.input, requestedPath);
  const { prefix, path: directoryPath } = preserveInput
    ? splitDirectoryInput(requestedPath) : { prefix: '', path: requestedPath };
  ui.error.textContent = '';
  ui.create.disabled = true;
  ui.up.disabled = true;
  stopVisiblePreloads();
  const entry = loadDirectory(directoryPath);
  if (!entry.result) {
    ui.list.setAttribute('aria-busy', 'true');
    ui.list.innerHTML = '<div class="new-project-empty">' + loadingSpinner() + ' Loading folders…</div>';
  }
  try {
    const response = entry.result || await entry.promise;
    if (version !== navigationVersion) return;
    if (prefix && !response.exists) throw new Error('Parent folder does not exist.');
    const entries = response.entries;
    currentDirectory = prefix ? {
      ...response,
      targetPath: joinDirectoryPath(response.path, prefix),
      parentPath: response.path,
      exists: entries.some(entry => entry.name === prefix),
    } : response;
    if (!preserveInput) setPathInput(ui.input, currentDirectory.targetPath);
    ui.up.disabled = currentDirectory.parentPath === currentDirectory.targetPath;
    renderDirectories(ui.list, entries, response.path, prefix, !currentDirectory.exists);
    ui.create.disabled = false;
  } catch (error) {
    if (version !== navigationVersion) return;
    ui.list.replaceChildren();
    ui.error.textContent = error.message === 'project not found'
      ? 'Update this device’s Bridge to browse folders.'
      : error.message || 'Could not load folders.';
  } finally {
    if (version === navigationVersion) ui.list.removeAttribute('aria-busy');
  }
}

export function onNewProjectPathInput() {
  ++navigationVersion;
  clearTimeout(inputTimer);
  stopVisiblePreloads();
  const ui = elements();
  ui.create.disabled = true;
  ui.up.disabled = true;
  const { path } = splitDirectoryInput(ui.input.value.trim());
  if (directoryCache.get(directoryKey(path))?.result) {
    browseNewProjectPath(undefined, true);
  } else {
    inputTimer = setTimeout(() => browseNewProjectPath(undefined, true), 250);
  }
}

export function newProjectParentDirectory() {
  if (currentDirectory) return browseNewProjectPath(currentDirectory.parentPath);
}

export function closeNewProjectDirectoryPicker() {
  ++navigationVersion;
  clearTimeout(inputTimer);
  stopVisiblePreloads();
  currentDirectory = null;
  directoryCache = new Map();
}
