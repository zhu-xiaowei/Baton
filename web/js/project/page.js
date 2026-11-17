import { createBreadcrumb } from '../components/breadcrumb.js';
import { GIT_BRANCH_ICON_SVG } from '../components/icons.js';

var page = null;
var content = null;
var breadcrumb = null;
var breadcrumbComponent = null;
var onBack = null;
var onNavigate = null;
var onGit = null;
var returnFocus = null;

function ensurePage() {
  if (page) return page;
  page = document.createElement('section');
  page.id = 'projectFilesPage';
  page.className = 'project-files-page';
  page.hidden = true;
  page.setAttribute('aria-label', 'Project files');
  page.innerHTML = '<div class="path-breadcrumb project-files-page-breadcrumb"></div>'
    + '<div class="project-files-page-content"></div>';
  document.body.appendChild(page);
  breadcrumb = page.querySelector('.project-files-page-breadcrumb');
  content = page.querySelector('.project-files-page-content');
  breadcrumbComponent = createBreadcrumb(breadcrumb, {
    onBack: function () {
      if (typeof onBack === 'function') onBack();
    },
    onNavigate: function (value) {
      if (typeof onNavigate === 'function') onNavigate(value);
    },
  });
  document.addEventListener('keydown', function (event) {
    if (!page.hidden && event.key === 'Escape' && typeof onBack === 'function'
      && document.getElementById('fileOverlay')?.style.display !== 'flex'
      && !window.sideDockOutside?.(event)) {
      onBack();
    }
  });
  return page;
}

export function openProjectFilesPage(options) {
  options = options || {};
  ensurePage();
  if (page.hidden) returnFocus = document.activeElement;
  onBack = options.onBack;
  onNavigate = options.onNavigate;
  onGit = options.onGit;
  page.hidden = false;
  if (window.attachScrollIndicator) window.attachScrollIndicator(content);
}

export function closeProjectFilesPage() {
  if (!page) return;
  breadcrumbComponent.setLoading(false);
  if (page.contains(document.activeElement)) document.activeElement.blur();
  page.hidden = true;
  onBack = null;
  onNavigate = null;
  onGit = null;
  if (returnFocus && returnFocus.isConnected) {
    returnFocus.focus({ preventScroll: true });
  }
  returnFocus = null;
}

export function renderProjectFilesBreadcrumb(items) {
  ensurePage();
  breadcrumbComponent.render(items);
  if (onGit) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'workspace-switch';
    button.setAttribute('aria-label', 'Git changes');
    button.innerHTML = GIT_BRANCH_ICON_SVG;
    button.addEventListener('click', onGit);
    breadcrumb.appendChild(button);
  }
  window.syncSidePanel?.();
}

export function setProjectFilesLoading(loading) {
  ensurePage();
  breadcrumbComponent.setLoading(loading);
}

export function projectFilesContent() {
  ensurePage();
  return content;
}

export function projectFilesPageElement() {
  return ensurePage();
}
