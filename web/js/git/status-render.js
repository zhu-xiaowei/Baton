import { fileIconHtml } from '../components/file-icon.js';

const STATUS_CODE = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  type_changed: 'T',
  untracked: 'U',
  conflicted: '!',
};

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function splitPath(value) {
  var index = value.lastIndexOf('/');
  return index < 0
    ? { name: value, directory: '' }
    : { name: value.slice(index + 1), directory: value.slice(0, index) };
}

function iconButton(icon, label, operation, group, path, disabled) {
  return '<button class="git-action' + (disabled ? ' disabled' : '') + '" type="button"'
    + ' aria-label="' + esc(label) + '" data-operation="' + operation + '"'
    + ' data-group="' + group + '"' + (path ? ' data-path="' + esc(path) + '"' : '')
    + (disabled ? ' disabled' : '') + '>' + icon + '</button>';
}

const PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const MINUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>';
const UNDO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7 4 12l5 5"/><path d="M5 12h9a5 5 0 0 1 5 5"/></svg>';
const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>';

export function gitFileRowHtml(entry, attrs, actions) {
  var parts = splitPath(entry.path);
  var subtitle = entry.previousPath
    ? entry.previousPath + ' → ' + (parts.directory || '.')
    : parts.directory;
  return '<div class="git-file-row"' + attrs + ' data-path="' + esc(entry.path) + '">'
    + '<button class="git-file-main" type="button">'
    + '<span class="git-file-icon">' + fileIconHtml(parts.name) + '</span>'
    + '<span class="git-file-copy"><span class="git-file-name" title="' + esc(parts.name) + '">'
    + esc(parts.name) + '</span>'
    + (subtitle ? '<span class="git-file-directory" title="' + esc(subtitle) + '">'
      + esc(subtitle) + '</span>' : '')
    + '</span><span class="git-status git-status-' + entry.status + '">'
    + (STATUS_CODE[entry.status] || '?') + '</span></button>'
    + (actions ? '<span class="git-row-actions">' + actions + '</span>' : '') + '</div>';
}

function rowHtml(entry, group, busy) {
  var name = splitPath(entry.path).name;
  var actions = group === 'staged'
    ? iconButton(MINUS, 'Unstage ' + name, 'unstage', group, entry.path, busy)
    : (group === 'conflicts'
      ? iconButton(PLUS, 'Stage resolved ' + name, 'stage', group, entry.path, busy)
      : iconButton(UNDO, 'Discard ' + name, 'discard', group, entry.path, busy)
        + iconButton(PLUS, 'Stage ' + name, 'stage', group, entry.path, busy));
  return gitFileRowHtml(entry, ' data-group="' + group + '"', actions);
}

function sectionHtml(group, title, entries, collapsed, busy, always) {
  if (!always && !entries.length) return '';
  var actions = !entries.length ? '' : (group === 'staged'
    ? iconButton(MINUS, 'Unstage all', 'unstage', group, '', busy)
    : (group === 'conflicts'
      ? iconButton(PLUS, 'Stage all resolved', 'stage', group, '', busy)
      : iconButton(UNDO, 'Discard all', 'discard', group, '', busy)
        + iconButton(PLUS, 'Stage all', 'stage', group, '', busy)));
  return '<section class="git-section' + (collapsed ? ' collapsed' : '') + '" data-group="' + group + '">'
    + '<div class="git-section-header"><button class="git-section-toggle" type="button"'
    + ' aria-expanded="' + String(!collapsed) + '">' + CHEVRON
    + '<span>' + title + '</span>' + (entries.length ? '<span class="git-count">' + entries.length + '</span>' : '')
    + '</button><span class="git-section-actions">' + actions + '</span></div>'
    + '<div class="git-section-files">' + entries.map(function (entry) {
      return rowHtml(entry, group, busy);
    }).join('') + '</div></section>';
}

export function renderGitStatus(content, snapshot, options) {
  options = options || {};
  var groups = snapshot?.groups || { conflicts: [], staged: [], changes: [] };
  content.innerHTML = (options.error
    ? '<div class="git-error">' + esc(options.error) + '</div>'
    : '')
    + sectionHtml('conflicts', 'Merge Changes', groups.conflicts || [], options.collapsed?.has('conflicts'), options.busy, false)
    + sectionHtml('staged', 'Staged Changes', groups.staged || [], options.collapsed?.has('staged'), options.busy, false)
    + sectionHtml('changes', 'Changes', groups.changes || [], options.collapsed?.has('changes'), options.busy, true);
  content.onclick = function (event) {
    var action = event.target.closest('.git-action');
    if (action && !action.disabled) {
      options.onMutation?.({
        operation: action.dataset.operation,
        group: action.dataset.group,
        path: action.dataset.path || '',
      });
      return;
    }
    var toggle = event.target.closest('.git-section-toggle');
    if (toggle) {
      options.onToggle?.(toggle.closest('.git-section').dataset.group);
      return;
    }
    var main = event.target.closest('.git-file-main');
    if (main) {
      var row = main.closest('.git-file-row');
      options.onDiff?.(row.dataset.path, row.dataset.group);
    }
  };
}
