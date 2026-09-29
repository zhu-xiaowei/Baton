import { backButtonHtml } from '../components/back-button.js';
import { setBreadcrumbItemsLoading } from '../components/breadcrumb.js';
import { FOLDER_ICON_SVG, GIT_BRANCH_ICON_SVG } from '../components/icons.js';

var page;
var content;
var header;
var projectLabel;
var branchLabel;
var groupsContent;
var commitBarContent;
var historyContent;
var onBack;
var onFiles;
var onRefresh;
var returnFocus;

function ensurePage() {
  if (page) return;
  page = document.createElement('section');
  page.id = 'gitStatusPage';
  page.className = 'git-status-page';
  page.hidden = true;
  page.innerHTML = '<div class="path-breadcrumb git-status-header">'
    + backButtonHtml({ className: 'git-status-back' })
    + '<div class="git-status-heading">'
    + '<button class="path-breadcrumb-item git-status-project" type="button"'
    + ' aria-label="Refresh Git changes"></button>'
    + '<span class="git-status-branch" hidden><span class="path-breadcrumb-separator">›</span>'
    + GIT_BRANCH_ICON_SVG + '<span class="git-status-branch-name"></span>'
    + '<span class="git-status-sync"></span></span></div>'
    + '<button class="workspace-switch" type="button" aria-label="Project files">'
    + FOLDER_ICON_SVG + '</button></div>'
    + '<div class="git-status-content"><div class="git-status-list">'
    + '<div class="git-commit-bar" hidden></div><div class="git-status-groups"></div>'
    + '<div class="git-history"></div></div></div>';
  document.body.appendChild(page);
  header = page.querySelector('.git-status-header');
  content = page.querySelector('.git-status-content');
  projectLabel = page.querySelector('.git-status-project');
  branchLabel = page.querySelector('.git-status-branch');
  groupsContent = page.querySelector('.git-status-groups');
  commitBarContent = page.querySelector('.git-commit-bar');
  historyContent = page.querySelector('.git-history');
  page.querySelector('.git-status-back').addEventListener('click', function () { onBack?.(); });
  page.querySelector('.workspace-switch').addEventListener('click', function () { onFiles?.(); });
  projectLabel.addEventListener('click', function () { onRefresh?.(); });
  document.addEventListener('keydown', function (event) {
    if (!page.hidden
      && event.key === 'Escape'
      && document.getElementById('fileOverlay')?.style.display !== 'flex') {
      onBack?.();
    }
  });
}

export function openGitPage(options) {
  ensurePage();
  if (page.hidden) returnFocus = document.activeElement;
  onBack = options.onBack;
  onFiles = options.onFiles;
  onRefresh = options.onRefresh;
  page.hidden = false;
  window.attachScrollIndicator?.(content);
}

export function closeGitPage() {
  if (!page) return;
  setGitLoading(false);
  page.hidden = true;
  onBack = null;
  onFiles = null;
  onRefresh = null;
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  returnFocus = null;
}

export function renderGitHeader(projectName, repository) {
  ensurePage();
  projectLabel.textContent = projectName || 'Project';
  branchLabel.hidden = !repository;
  if (!repository) return;
  var name = repository.detached
    ? 'HEAD @ ' + String(repository.headOid || '').slice(0, 7)
    : (repository.branch || 'HEAD');
  var sync = (repository.ahead ? '↑' + repository.ahead : '')
    + (repository.behind ? (repository.ahead ? ' ' : '') + '↓' + repository.behind : '');
  branchLabel.querySelector('.git-status-branch-name').textContent = name;
  branchLabel.querySelector('.git-status-sync').textContent = sync;
  branchLabel.title = name + (repository.upstream ? ' · ' + repository.upstream : '')
    + (sync ? ' ' + sync : '');
}

export function setGitLoading(value) {
  ensurePage();
  setBreadcrumbItemsLoading([projectLabel], !!value);
  header.toggleAttribute('aria-busy', !!value);
}

export function gitContent() {
  ensurePage();
  return groupsContent;
}

export function gitCommitBarContent() {
  ensurePage();
  return commitBarContent;
}

export function gitHistoryContent() {
  ensurePage();
  return historyContent;
}

export function gitScrollContent() {
  ensurePage();
  return content;
}
