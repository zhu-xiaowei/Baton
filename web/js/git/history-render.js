import { loadingSpinner } from '../components/loading.js';
import { LANE_COLORS } from './graph-layout.js';
import { gitFileRowHtml } from './status-render.js';

const ROW_HEIGHT = 34;
const NODE_Y = 17;
const GRAPH_PAD = 8;
const GRAPH_BUDGET = 84;
const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>';

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function graphMetrics(rows) {
  var lanes = rows.reduce(function (max, row) { return Math.max(max, row.width); }, 1);
  var spacing = Math.max(7, Math.min(12, Math.floor(GRAPH_BUDGET / lanes)));
  return { spacing: spacing, width: GRAPH_PAD * 2 + (lanes - 1) * spacing };
}

function laneX(index, metrics) { return GRAPH_PAD + index * metrics.spacing; }

function curveTail(x1, y1, x2, y2) {
  if (x1 === x2) return 'V' + y2;
  var mid = (y1 + y2) / 2;
  return 'C' + x1 + ' ' + mid + ' ' + x2 + ' ' + mid + ' ' + x2 + ' ' + y2;
}

function curve(x1, y1, x2, y2) {
  return 'M' + x1 + ' ' + y1 + curveTail(x1, y1, x2, y2);
}

function stroke(d, color) {
  return '<path d="' + d + '" stroke="' + LANE_COLORS[color] + '"/>';
}

export function isGraphEnd(row, model) {
  return !model.hasMore && model.rows[model.rows.length - 1] === row;
}

function graphSvg(row, metrics, head, height, end) {
  var x = laneX(row.col, metrics);
  var paths = '';
  row.through.forEach(function (lane) {
    var from = laneX(lane.from, metrics);
    paths += stroke('M' + from + ' 0V' + NODE_Y + (end ? '' : curveTail(from, NODE_Y, laneX(lane.to, metrics), height)), lane.color);
  });
  row.converging.forEach(function (lane) {
    paths += stroke(curve(laneX(lane.from, metrics), 0, x, NODE_Y), lane.color);
  });
  if (row.hasTop) paths += stroke('M' + x + ' 0V' + NODE_Y, row.color);
  if (!end) row.bottom.forEach(function (edge) {
    paths += stroke(curve(x, NODE_Y, laneX(edge.to, metrics), height), edge.color);
  });
  var color = LANE_COLORS[row.color];
  var node = row.commit.parents.length > 1
    ? '<circle cx="' + x + '" cy="' + NODE_Y + '" r="3.5" fill="#0d1117" stroke="' + color + '" stroke-width="2"/>'
    : '<circle cx="' + x + '" cy="' + NODE_Y + '" r="4" fill="' + color + '"/>';
  if (head) node = '<circle cx="' + x + '" cy="' + NODE_Y + '" r="6" fill="#0d1117" stroke="' + color + '" stroke-width="2"/>'
    + '<circle cx="' + x + '" cy="' + NODE_Y + '" r="2.5" fill="' + color + '"/>';
  return '<svg class="git-graph-svg" width="' + metrics.width + '" height="' + height + '" aria-hidden="true">'
    + paths + node + '</svg>';
}

function railSvg(row, metrics, end) {
  var paths = end ? '' : row.after.map(function (color, index) {
    var x = laneX(index, metrics);
    return '<path d="M' + x + ' 0V10" stroke="' + LANE_COLORS[color] + '" vector-effect="non-scaling-stroke"/>';
  }).join('');
  return '<svg class="git-graph-rail" width="' + metrics.width + '" viewBox="0 0 ' + metrics.width + ' 10"'
    + ' preserveAspectRatio="none" aria-hidden="true">' + paths + '</svg>';
}

function formatClock(seconds) {
  var date = new Date(seconds * 1000);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(function (part) {
    return String(part).padStart(2, '0');
  }).join(':');
}

function formatDate(seconds) {
  var date = new Date(seconds * 1000);
  var diff = Date.now() - date.getTime();
  if (diff < 3600e3) return Math.max(1, Math.round(diff / 60e3)) + 'm';
  if (diff < 86400e3) return Math.round(diff / 3600e3) + 'h';
  if (diff < 7 * 86400e3) return Math.round(diff / 86400e3) + 'd';
  var month = String(date.getMonth() + 1).padStart(2, '0');
  var day = String(date.getDate()).padStart(2, '0');
  return date.getFullYear() === new Date().getFullYear()
    ? month + '-' + day
    : date.getFullYear() + '-' + month + '-' + day;
}

function statsHtml(stats) {
  if (!stats?.files) return '';
  return ' · ' + stats.files + (stats.files === 1 ? ' file' : ' files')
    + (stats.insertions ? ' <span class="git-stat-add">+' + stats.insertions + '</span>' : '')
    + (stats.deletions ? ' <span class="git-stat-del">−' + stats.deletions + '</span>' : '');
}

function refChips(refs, expanded) {
  if (!refs?.length) return '';
  var names = refs.map(function (ref) { return ref.name; }).join(', ');
  return (expanded ? refs : refs.slice(0, 1)).map(function (ref) {
    return '<span class="git-ref git-ref-' + ref.kind + (ref.head ? ' git-ref-head' : '') + '" title="' + esc(expanded ? ref.name : names) + '">'
      + esc(ref.name) + '</span>';
  }).join('')
    + (!expanded && refs.length > 1 ? '<span class="git-ref git-ref-more" title="' + esc(names) + '">+' + (refs.length - 1) + '</span>' : '');
}

export function commitDetailHtml(row, metrics, files, end) {
  var body = files?.entry
    ? (files.entry.files.length
      ? files.entry.files.map(function (file) { return gitFileRowHtml(file, '', ''); }).join('')
      : '<div class="git-history-note">No file changes against the first parent.</div>')
    : (files?.error
      ? '<div class="git-error">' + esc(files.error) + '</div>'
      : '<div class="git-history-loading">' + loadingSpinner({ label: 'Loading files' }) + '</div>');
  return '<div class="git-commit-detail">' + railSvg(row, metrics, end)
    + '<div class="git-commit-detail-body">' + body + '</div></div>';
}

export function commitRowHtml(row, metrics, model) {
  var commit = row.commit;
  var expanded = model.expanded.has(commit.oid);
  var end = isGraphEnd(row, model);
  var attribution = '<span class="git-commit-author" title="' + esc(commit.authorName) + '">' + esc(commit.authorName) + '</span>'
    + refChips(commit.refs, expanded);
  return '<div class="git-commit' + (expanded ? ' expanded' : '') + '" data-oid="' + commit.oid + '">'
    + '<button class="git-commit-main" type="button" aria-expanded="' + expanded + '">'
    + '<span class="git-graph" style="width:' + metrics.width + 'px">'
    + graphSvg(row, metrics, commit.oid === model.headOid, ROW_HEIGHT, end)
    + (expanded && !end ? railSvg(row, metrics, false) : '') + '</span>'
    + '<span class="git-commit-copy"><span class="git-commit-line">'
    + '<span class="git-commit-subject">' + esc(commit.subject) + '</span>'
    + (expanded ? '' : attribution)
    + '<span class="git-commit-time">' + formatDate(commit.authorTime) + '</span></span>'
    + (expanded ? '<span class="git-commit-line git-commit-attribution">' + attribution + '</span>'
      + '<span class="git-commit-line git-commit-meta">'
      + '<span class="git-commit-id"><span class="git-commit-hash" role="button" tabindex="0"'
      + ' data-oid="' + commit.oid + '" title="Copy full hash" aria-label="Copy commit hash">'
      + commit.oid.slice(0, 7) + '</span>' + statsHtml(commit.stats) + '</span>'
      + '<span class="git-commit-time">' + formatClock(commit.authorTime) + '</span></span>' : '')
    + '</span></button>'
    + (expanded ? commitDetailHtml(row, metrics, model.files.get(commit.oid), end) : '')
    + '</div>';
}

export function commitRowsHtml(rows, metrics, model) {
  return rows.map(function (row) { return commitRowHtml(row, metrics, model); }).join('');
}

export function historyFooterHtml(model) {
  if (model.error) return '<div class="git-error">' + esc(model.error) + '</div>'
    + (model.rows.length ? '<button class="git-history-more" type="button">Retry</button>' : '');
  if (model.loading && (!model.refreshing || !model.rows.length)) {
    return '<div class="git-history-loading">' + loadingSpinner({ label: 'Loading history' }) + '</div>';
  }
  if (!model.rows.length && !model.loading) return '<div class="git-history-note">No commits yet.</div>';
  return '';
}

export function renderHistory(container, model, metrics) {
  var body = model.unsupported
    ? '<div class="git-history-note">Update the Bridge to view commit history.</div>'
    : '<div class="git-history-rows">' + commitRowsHtml(model.rows, metrics, model) + '</div>'
      + '<div class="git-history-footer">' + historyFooterHtml(model) + '</div>';
  container.innerHTML = '<section class="git-section git-history-section' + (model.collapsed ? ' collapsed' : '') + '">'
    + '<div class="git-section-header"><button class="git-section-toggle git-history-toggle" type="button"'
    + ' aria-expanded="' + String(!model.collapsed) + '">' + CHEVRON + '<span>Graph</span>'
    + '<span class="git-history-spinner"' + (model.loading && model.refreshing && model.rows.length ? '' : ' hidden') + '>'
    + loadingSpinner({ size: 'small', label: 'Refreshing history' }) + '</span></button>'
    + '<span class="git-section-actions"><button class="git-ref-picker" type="button"'
    + ' aria-label="Choose history branches"><span class="path-breadcrumb-item git-ref-picker-pill">'
    + '<span class="git-ref-picker-label">' + esc(model.scopeLabel) + '</span>' + CHEVRON + '</span></button></span></div>'
    + '<div class="git-section-files">' + body + '</div></section>';
}
