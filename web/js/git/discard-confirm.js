import { showCenteredModal, hideCenteredModal } from '../components/modal-viewport.js';

export function confirmDiscard(options) {
  options = options || {};
  return new Promise(function (resolve) {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay git-discard-overlay';
    var count = options.count || 1;
    var all = !!options.all;
    overlay.innerHTML = '<div class="modal-box" role="dialog" aria-modal="true">'
      + '<div class="modal-title">' + (all ? 'Discard all changes?' : 'Discard changes?') + '</div>'
      + '<div class="modal-desc">'
      + (all ? 'This will discard ' + count + ' working tree changes.' : 'This will discard changes to ' + escapeHtml(options.path) + '.')
      + (options.untracked ? '<br><br>Untracked files will be permanently deleted.' : '')
      + '</div><div class="modal-actions">'
      + '<button class="modal-btn cancel" type="button">Cancel</button>'
      + '<button class="modal-btn confirm danger" type="button">Discard</button>'
      + '</div></div>';
    function finish(value) {
      document.removeEventListener('keydown', onKey);
      hideCenteredModal(overlay);
      overlay.remove();
      resolve(value);
    }
    function onKey(event) {
      if (event.key === 'Escape') finish(false);
    }
    overlay.addEventListener('click', function (event) {
      if (event.target === overlay || event.target.closest('.cancel')) finish(false);
      if (event.target.closest('.confirm')) finish(true);
    });
    showCenteredModal(overlay);
    document.addEventListener('keydown', onKey);
    overlay.querySelector('.cancel').focus({ preventScroll: true });
  });
}

function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
