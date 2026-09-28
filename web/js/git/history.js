import { state } from '../state.js';
import { readProjectDataCache, writeProjectDataCache } from '../cache/project-data-cache.js';
import { openGitCommitDiff } from './diff-viewer.js';
import { createGraphLayout, layoutCommits } from './graph-layout.js';
import {
  commitDetailHtml,
  commitRowHtml,
  commitRowsHtml,
  graphMetrics,
  historyFooterHtml,
  isGraphEnd,
  renderHistory,
} from './history-render.js';
import { pickGitRef } from './ref-picker.js';
import { requestGit } from './rpc.js';

const PAGE_SIZE = 50;
const PRELOAD_PX = 1200;

var container = null;
var scroller = null;
var projectHash = '';
var projectKey = '';
var repository = null;
var model = freshModel();

function freshModel() {
  return {
    collapsed: true,
    scope: 'auto',
    heads: null,
    layout: createGraphLayout(),
    rows: [],
    hasMore: false,
    loading: false,
    error: '',
    expanded: new Set(),
    files: new Map(),
    headOid: '',
    unsupported: false,
    generation: 0,
    scopeLabel: '',
    refs: null,
    refreshing: false,
    retryReset: false,
    touched: false,
  };
}

// History reuses the Changes IndexedDB cache: view state, first page per scope, and the branch list.
function cacheFields(type, path) {
  return {
    server: state.SERVER,
    device: state.appState.device || '',
    projectHash: projectHash,
    type: type,
    path: path || '',
  };
}

function saveView() {
  model.touched = true;
  writeProjectDataCache(cacheFields('git-history', ''), { collapsed: model.collapsed, scope: model.scope });
}

function scopeLabel() {
  if (model.scope === 'auto') return repository?.branch || (repository?.detached ? 'HEAD' : 'Auto');
  if (model.scope === 'all') return 'All branches';
  return model.scope.replace(/^refs\/(heads|remotes)\//, '');
}

function render() {
  if (!container) return;
  model.scopeLabel = scopeLabel();
  renderHistory(container, model, graphMetrics(model.rows));
}

function renderFooter() {
  var footer = container?.querySelector('.git-history-footer');
  if (footer) footer.innerHTML = historyFooterHtml(model);
  else render();
}

function scopeFields() {
  if (model.scope === 'auto' || model.scope === 'all') return { scope: model.scope };
  return { scope: 'ref', ref: model.scope };
}

function setHeaderLoading(value) {
  container?.querySelector('.git-history-spinner')?.toggleAttribute('hidden', !value);
}

function applyPage(result, reset) {
  if (reset) {
    model.layout = createGraphLayout();
    model.rows = [];
  }
  var rows = layoutCommits(model.layout, result.commits || []);
  model.heads = result.heads || model.heads;
  model.rows = model.rows.concat(rows);
  model.hasMore = !!result.hasMore;
  if (reset) {
    var present = new Set(model.rows.map(function (row) { return row.commit.oid; }));
    model.expanded = new Set([...model.expanded].filter(function (oid) { return present.has(oid); }));
  }
  return rows;
}

// A reset keeps the cached or current rows visible and replaces them when the fresh first page arrives.
async function loadPage(reset) {
  if (model.unsupported || (!reset && model.loading)) return;
  if (reset) model.generation++;
  var generation = model.generation;
  var owner = model;
  model.loading = true;
  model.refreshing = reset;
  model.error = '';
  if (reset && !model.rows.length) render();
  else {
    setHeaderLoading(reset);
    renderFooter();
  }
  try {
    var result = await requestGit('history', {
      projectHash: projectHash,
      ...scopeFields(),
      ...(!reset && model.heads ? { heads: model.heads, skip: model.rows.length } : {}),
      limit: PAGE_SIZE,
    });
    if (model !== owner || generation !== model.generation) return;
    var before = graphMetrics(model.rows);
    var rows = applyPage(result, reset);
    model.loading = false;
    model.refreshing = false;
    var after = graphMetrics(model.rows);
    var list = container?.querySelector('.git-history-rows');
    if (reset) {
      writeProjectDataCache(cacheFields('git-history-page', model.scope), {
        heads: result.heads,
        commits: result.commits,
        hasMore: result.hasMore,
      });
      render();
    } else if (list && before.spacing === after.spacing && before.width === after.width) {
      list.insertAdjacentHTML('beforeend', commitRowsHtml(rows, after, model));
      renderFooter();
    } else {
      render();
    }
    requestAnimationFrame(maybeLoadMore);
  } catch (error) {
    if (model !== owner || generation !== model.generation) return;
    model.loading = false;
    model.refreshing = false;
    model.retryReset = reset;
    model.error = error.message || 'Could not load history.';
    setHeaderLoading(false);
    renderFooter();
  }
}

// Show the cached first page at once, then revalidate it from the Bridge.
async function expandGraph() {
  var owner = model;
  if (!owner.rows.length) {
    var page = await readProjectDataCache(cacheFields('git-history-page', owner.scope));
    if (model !== owner || owner.collapsed) return;
    if (page?.data && !owner.rows.length && !owner.loading) {
      applyPage(page.data, true);
      render();
    }
  }
  if (model === owner && !owner.collapsed) loadPage(true);
}

async function hydrate(owner) {
  var records = await Promise.all([
    readProjectDataCache(cacheFields('git-history', '')),
    readProjectDataCache(cacheFields('git-refs', '')),
  ]);
  if (model !== owner) return;
  if (records[1]?.data && !owner.refs) owner.refs = records[1].data;
  if (records[0]?.data && !owner.touched) {
    owner.collapsed = !!records[0].data.collapsed;
    owner.scope = records[0].data.scope || 'auto';
  }
  render();
  if (!owner.collapsed) expandGraph();
}

// Same near-bottom preload as the Session/Project lists; errors stop it until Retry.
function maybeLoadMore() {
  if (!scroller || model.collapsed || model.unsupported || model.loading || model.error || !model.hasMore) return;
  if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < PRELOAD_PX) loadPage(false);
}

function renderExpanded(oid) {
  var element = container?.querySelector('.git-commit[data-oid="' + oid + '"]');
  var row = model.rows.find(function (item) { return item.commit.oid === oid; });
  if (element && row) element.outerHTML = commitRowHtml(row, graphMetrics(model.rows), model);
}

function renderFiles(oid) {
  var detail = container?.querySelector('.git-commit[data-oid="' + oid + '"] .git-commit-detail');
  var row = model.rows.find(function (item) { return item.commit.oid === oid; });
  if (detail && row) detail.outerHTML = commitDetailHtml(row, graphMetrics(model.rows), model.files.get(oid), isGraphEnd(row, model));
}

async function toggleCommit(oid) {
  if (model.expanded.delete(oid)) return renderExpanded(oid);
  model.expanded.add(oid);
  renderExpanded(oid);
  var cached = model.files.get(oid);
  if (cached?.entry || cached?.loading) return;
  var generation = model.generation;
  model.files.set(oid, { loading: true });
  try {
    var entry = await requestGit('commit_files', { projectHash: projectHash, commitOid: oid });
    if (generation !== model.generation) return;
    model.files.set(oid, { entry: entry });
  } catch (error) {
    if (generation !== model.generation) return;
    model.files.set(oid, { error: error.message || 'Could not load files.' });
  }
  if (model.expanded.has(oid)) renderFiles(oid);
}

async function chooseScope() {
  var value = await pickGitRef({
    repository: repository,
    selected: model.scope,
    cachedRefs: model.refs,
    loadRefs: async function () {
      var owner = model;
      var refs = (await requestGit('refs', { projectHash: projectHash })).refs || [];
      if (model === owner) {
        owner.refs = refs;
        writeProjectDataCache(cacheFields('git-refs', ''), refs);
      }
      return refs;
    },
  });
  if (!value) return;
  var changed = value !== model.scope;
  model.scope = value;
  model.collapsed = false;
  saveView();
  if (changed) {
    model.generation++;
    model.loading = false;
    model.layout = createGraphLayout();
    model.rows = [];
    model.heads = null;
    model.hasMore = false;
    model.expanded = new Set();
  }
  render();
  expandGraph();
}

function copyHash(element) {
  var label = element.textContent;
  function flash(text, className) {
    element.textContent = text;
    element.classList.add(className);
    setTimeout(function () {
      element.textContent = label;
      element.classList.remove(className);
    }, 1200);
  }
  if (element.classList.contains('copied') || element.classList.contains('copy-failed')) return;
  if (!navigator.clipboard?.writeText) return flash('Copy failed', 'copy-failed');
  navigator.clipboard.writeText(element.dataset.oid).then(function () {
    flash('Copied', 'copied');
  }, function () {
    flash('Copy failed', 'copy-failed');
  });
}

function onClick(event) {
  var hash = event.target.closest('.git-commit-hash');
  if (hash) return copyHash(hash);
  if (event.target.closest('.git-ref-picker')) return chooseScope();
  if (event.target.closest('.git-history-toggle')) {
    model.collapsed = !model.collapsed;
    saveView();
    render();
    if (!model.collapsed && !model.loading) expandGraph();
    return;
  }
  if (event.target.closest('.git-history-more')) return loadPage(model.retryReset);
  var file = event.target.closest('.git-commit-detail .git-file-row');
  if (file) {
    var oid = file.closest('.git-commit').dataset.oid;
    var entry = model.files.get(oid)?.entry;
    var target = entry?.files.find(function (item) { return item.path === file.dataset.path; });
    if (target) openGitCommitDiff(oid, target);
    return;
  }
  var commit = event.target.closest('.git-commit-main');
  if (commit) toggleCommit(commit.closest('.git-commit').dataset.oid);
}

export function mountGitHistory(options) {
  if (container !== options.container) {
    container = options.container;
    container.addEventListener('click', onClick);
  }
  if (scroller !== options.scroller) {
    scroller = options.scroller;
    scroller?.addEventListener('scroll', maybeLoadMore, { passive: true });
  }
  projectHash = options.projectHash;
  if (projectKey !== options.projectKey) {
    projectKey = options.projectKey;
    repository = null;
    model = freshModel();
    render();
    hydrate(model);
    return;
  }
  render();
  if (!model.collapsed) expandGraph();
}

export function updateGitHistorySnapshot(snapshot) {
  if (!snapshot?.repository) return;
  var headChanged = repository && repository.headOid !== snapshot.repository.headOid;
  repository = snapshot.repository;
  model.headOid = repository.headOid || '';
  var unsupported = snapshot.capabilities?.history !== 1;
  if (unsupported !== model.unsupported || headChanged) {
    model.unsupported = unsupported;
    if (!model.collapsed && !unsupported && headChanged) loadPage(true);
    else render();
  } else if (container?.querySelector('.git-ref-picker-label')) {
    container.querySelector('.git-ref-picker-label').textContent = scopeLabel();
  }
}

export function refreshGitHistory() {
  if (!model.collapsed && !model.unsupported) loadPage(true);
}
