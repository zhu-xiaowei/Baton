import { hideCenteredModal, showCenteredModal } from '../components/modal-viewport.js';
import { CHECK_ICON_SVG, CLOSE_ICON_SVG } from '../components/icons.js';
import { loadingSpinner } from '../components/loading.js';

const FILTER_THRESHOLD = 10;

function esc(value) {
  return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function optionHtml(value, label, detail, selected) {
  return '<button class="git-ref-option' + (selected ? ' selected' : '') + '" type="button" data-value="' + esc(value) + '">'
    + '<span class="git-ref-option-check">' + (selected ? CHECK_ICON_SVG : '') + '</span>'
    + '<span class="git-ref-option-label">' + esc(label) + '</span>'
    + (detail ? '<span class="git-ref-option-detail">' + esc(detail) + '</span>' : '') + '</button>';
}

function listHtml(refs, repository, selected, filter) {
  var query = filter.trim().toLowerCase();
  var matches = refs.filter(function (ref) { return !query || ref.name.toLowerCase().includes(query); });
  var current = repository?.branch || 'HEAD';
  var html = query ? '' : optionHtml('auto', 'Auto', current + (repository?.upstream ? ' + ' + repository.upstream : ''), selected === 'auto')
    + optionHtml('all', 'All branches', '', selected === 'all');
  [['local', 'Local branches'], ['remote', 'Remote branches']].forEach(function (group) {
    var items = matches.filter(function (ref) { return ref.kind === group[0]; });
    if (!items.length) return;
    html += '<div class="git-ref-group">' + group[1] + '</div>' + items.map(function (ref) {
      return optionHtml(ref.ref, ref.name, ref.kind === 'local' && ref.name === repository?.branch ? 'current' : '', selected === ref.ref);
    }).join('');
  });
  return html || '<div class="git-history-note">No matching branches.</div>';
}

// Resolves to 'auto' | 'all' | full ref name, or null; cached refs render at once and refresh in the background.
export function pickGitRef(options) {
  return new Promise(function (resolve) {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay git-ref-overlay';
    overlay.innerHTML = '<div class="modal-box git-ref-box" role="dialog" aria-modal="true">'
      + '<div class="git-ref-dialog-head"><div class="modal-title">Show history'
      + '<span class="git-ref-refreshing" hidden>' + loadingSpinner({ size: 'small', label: 'Refreshing branches' }) + '</span></div>'
      + '<button class="file-modal-close git-ref-close" type="button" aria-label="Close" title="Close">'
      + CLOSE_ICON_SVG + '</button></div>'
      + '<input class="git-ref-filter" type="search" placeholder="Filter branches" hidden>'
      + '<div class="git-ref-list"><div class="git-history-loading">' + loadingSpinner({ label: 'Loading branches' }) + '</div></div></div>';
    var list = overlay.querySelector('.git-ref-list');
    var filter = overlay.querySelector('.git-ref-filter');
    var refs = options.cachedRefs || null;
    function finish(value) {
      document.removeEventListener('keydown', onKey);
      hideCenteredModal(overlay);
      overlay.remove();
      resolve(value);
    }
    function onKey(event) { if (event.key === 'Escape') finish(null); }
    function draw() { list.innerHTML = listHtml(refs, options.repository, options.selected, filter.value); }
    overlay.addEventListener('click', function (event) {
      if (event.target === overlay || event.target.closest('.git-ref-close')) return finish(null);
      var option = event.target.closest('.git-ref-option');
      if (option) finish(option.dataset.value);
    });
    filter.addEventListener('input', draw);
    showCenteredModal(overlay);
    document.addEventListener('keydown', onKey);
    function apply(result) {
      refs = result;
      filter.hidden = refs.length <= FILTER_THRESHOLD;
      draw();
    }
    var refreshing = overlay.querySelector('.git-ref-refreshing');
    if (refs) {
      apply(refs);
      refreshing.hidden = false;
    }
    options.loadRefs().then(function (result) {
      refreshing.hidden = true;
      if (overlay.isConnected && JSON.stringify(result) !== JSON.stringify(refs)) apply(result);
    }, function (error) {
      refreshing.hidden = true;
      if (!refs && overlay.isConnected) list.innerHTML = '<div class="git-error">' + esc(error.message) + '</div>';
    });
  });
}
