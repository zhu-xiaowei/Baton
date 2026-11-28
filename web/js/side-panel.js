import { state } from './state.js';
import '../css/side-panel.css';

// Wide pointer screens dock the full-screen tool pages to the right of a device's
// pages instead of covering them. Narrow/touch layouts are unchanged.
const PANELS = {
  projectTerminalPage: () => window.closeProjectTerminal?.(),
  gitStatusPage: () => window.deactivateGitStatus?.(),
  projectFilesPage: () => window.deactivateProjectFiles?.(),
  internalBrowserPage: el => el.querySelector('[data-browser-action="close"]')?.click(),
  fileOverlay: () => window.closeFileViewer?.({ refresh: false }),
};
const ENTRY_PANELS = [
  ['.project-terminal-entry', 'projectTerminalPage'],
  ['.git-status-entry', 'gitStatusPage'],
  ['.project-files-entry[aria-label="Project files"]', 'projectFilesPage'],
  ['.project-files-entry[aria-label="Home files"]', 'projectFilesPage'],
];
const RATIO_KEY = 'baton-side-panel-ratio';
const MIN_PANEL = 320;
const MIN_CHAT = 380;
const wide = window.matchMedia('(min-width: 768px) and (hover: hover) and (pointer: fine)');
const MAX_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';
const RESTORE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/></svg>';

let visible = new Set();
let maximized = false;
let active = false;
// Device of the page the docked tool was opened on.
let owner = null;
const handle = document.createElement('div');
handle.className = 'side-dock-handle';
handle.setAttribute('role', 'separator');
handle.setAttribute('aria-orientation', 'vertical');

let lastPanel = null;

function isVisible(el) {
  if (!el || el.hidden) return false;
  return el.id === 'fileOverlay' ? el.style.display === 'flex' : true;
}

function panelWidth() {
  const width = window.innerWidth;
  const ratio = Number(localStorage.getItem(RATIO_KEY));
  const preferred = ratio > 0 && ratio < 1 ? ratio * width : Math.min(720, Math.max(400, width * 0.4));
  return Math.round(Math.max(MIN_PANEL, Math.min(preferred, width - MIN_CHAT)));
}

function canDock() {
  return wide.matches && !!state.appState.device && state.appState.session !== '__new__';
}

function ensureToggle(el) {
  const header = el.id === 'fileOverlay' ? el.querySelector('.file-modal-header')
    : el.id === 'internalBrowserPage' ? el.querySelector('.browser-window-actions')
      : el.querySelector('.path-breadcrumb');
  if (!header) return;
  let button = header.querySelector(':scope > .side-dock-toggle');
  if (!button) {
    button = document.createElement('button');
    button.type = 'button';
    // Same button classes as its neighbours, so hover feedback matches them.
    button.className = 'workspace-switch side-dock-toggle'
      + (el.id === 'internalBrowserPage' ? ' browser-button' : '');
    button.addEventListener('click', () => { maximized = !maximized; sync(); });
    const close = header.querySelector('[data-browser-action="close"]');
    header.insertBefore(button, close || null);
  }
  const label = maximized ? 'Restore side panel' : 'Expand panel';
  if (button.title !== label) {
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = maximized ? RESTORE_ICON : MAX_ICON;
  }
}

function sync() {
  const now = new Set(Object.keys(PANELS).map(id => document.getElementById(id)).filter(isVisible));
  const dock = canDock() && now.size > 0;
  if (dock) {
    const browser = document.getElementById('internalBrowserPage');
    // One tool at a time; a file viewer may stack on the tool that opened it,
    // but not on the browser, whose native view would cover it.
    const opened = [...now].filter(el => !visible.has(el) && (el.id !== 'fileOverlay' || now.has(browser)));
    if (opened.length || !active) {
      owner = { device: state.appState.device };
    }
    if (opened.length) {
      for (const el of now) {
        if (!opened.includes(el)) { now.delete(el); PANELS[el.id](el); }
      }
    }
    now.forEach(ensureToggle);
  }
  if (!canDock()) maximized = false;
  visible = now;
  if (dock) {
    // Stack the handle just above the front panel, below anything opened over it.
    const top = front();
    if (top.nextSibling !== handle) top.after(handle);
    handle.style.zIndex = getComputedStyle(top).zIndex;
  } else handle.remove();
  if (dock !== active) {
    active = dock;
    queueMicrotask(() => window.dispatchEvent(new Event('resize')));
  }
  document.body.classList.toggle('side-dock', dock);
  document.body.classList.toggle('side-dock-max', dock && maximized);
  if (dock) document.documentElement.style.setProperty('--side-w', panelWidth() + 'px');
  // CSS marks the matching header button; #top-right is re-rendered too often to hold a class.
  const tool = dock && [...now].find(el => el.id !== 'fileOverlay');
  if (tool) document.body.dataset.sidePanel = tool.id;
  else delete document.body.dataset.sidePanel;
}

function front() {
  const list = [...visible];
  return list.find(el => el.id === 'fileOverlay') || list[list.length - 1];
}

handle.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  event.preventDefault();
  handle.setPointerCapture(event.pointerId);
  document.body.classList.add('side-dock-resizing');
  const move = e => {
    const width = Math.max(MIN_PANEL, Math.min(window.innerWidth - e.clientX, window.innerWidth - MIN_CHAT));
    document.documentElement.style.setProperty('--side-w', Math.round(width) + 'px');
  };
  const end = e => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', end);
    handle.removeEventListener('pointercancel', end);
    document.body.classList.remove('side-dock-resizing');
    const width = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--side-w'));
    if (width) localStorage.setItem(RATIO_KEY, String(width / window.innerWidth));
    window.dispatchEvent(new Event('resize'));
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
});

// Clicking the header button of a docked tool brings it forward, then closes it.
document.addEventListener('click', event => {
  if (!active) return;
  const entry = ENTRY_PANELS.find(([selector]) => event.target.closest?.(selector));
  const panel = entry && [...visible].find(el => el.id === entry[1]);
  if (!panel) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const current = front();
  PANELS[current.id](current);
}, true);

const observed = new WeakSet();
const attributes = new MutationObserver(sync);
function watchPanels() {
  for (const id of Object.keys(PANELS)) {
    const el = document.getElementById(id);
    if (el && !observed.has(el)) {
      observed.add(el);
      attributes.observe(el, { attributes: true, attributeFilter: ['hidden', 'style'] });
    }
  }
  sync();
}
new MutationObserver(watchPanels).observe(document.body, { childList: true, attributes: true, attributeFilter: ['class'] });
wide.addEventListener('change', sync);
window.addEventListener('resize', () => { if (active) sync(); });
watchPanels();

// Docked tools own Esc only when the key comes from inside them. Clicking a
// non-focusable or re-rendered spot leaves focus on body, so fall back to the
// panel last clicked (not the element, which may have been replaced).
document.addEventListener('pointerdown', event => {
  lastPanel = [...visible].find(el => el.contains(event.target)) || null;
}, true);
function keyInPanel(event) {
  if (event.target === document.body) return visible.has(lastPanel);
  return [...visible].some(el => el.contains(event.target));
}
// Navigation within the device keeps the docked tool open.
window.sideDockKeeps = device => active && owner.device === device;
window.sideDockOutside = event => active && !keyInPanel(event);
window.sideDockInside = event => active && keyInPanel(event);
window.syncSidePanel = sync;
