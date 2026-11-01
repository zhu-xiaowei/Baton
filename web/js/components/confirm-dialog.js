import { showCenteredModal, hideCenteredModal } from './modal-viewport.js';

// In-page, because window.confirm returns false at once in the iOS app's WKWebView.
export function confirmDialog(message) {
  return new Promise(resolve => {
    const previousFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = '<div class="modal-box" role="alertdialog" aria-modal="true">'
      + '<div class="modal-title"></div><div class="modal-actions">'
      + '<button type="button" class="modal-btn cancel">Cancel</button>'
      + '<button type="button" class="modal-btn confirm">Confirm</button></div></div>';
    overlay.querySelector('.modal-title').textContent = message;
    const [cancel, confirm] = overlay.querySelectorAll('button');
    function close(confirmed) {
      hideCenteredModal(overlay);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      resolve(confirmed);
    }
    cancel.addEventListener('click', () => close(false));
    confirm.addEventListener('click', () => close(true));
    overlay.addEventListener('click', event => { if (event.target === overlay) close(false); });
    overlay.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); close(false); }
      if (event.key === 'Tab') { event.preventDefault(); (event.target === cancel ? confirm : cancel).focus(); }
    });
    showCenteredModal(overlay);
    confirm.focus({ preventScroll: true });
  });
}
