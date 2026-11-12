import { showCenteredModal, hideCenteredModal } from './modal-viewport.js';

// In-page, because window.confirm returns false at once in the iOS app's WKWebView.
// choices are [value, label, primary]; dismissing (Escape, backdrop) resolves `dismissed`, and
// `dismissed: null` makes the dialog impossible to dismiss.
export function confirmDialog(message, choices = [[false, 'Cancel'], [true, 'Confirm', true]], dismissed = false, detail = '') {
  return new Promise(resolve => {
    const previousFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    // Above the in-app browser page.
    overlay.style.zIndex = '1500';
    overlay.innerHTML = '<div class="modal-box" role="alertdialog" aria-modal="true" tabindex="-1">'
      + '<div class="modal-title"></div><div class="modal-actions"></div></div>';
    overlay.querySelector('.modal-title').textContent = message;
    if (detail) overlay.querySelector('.modal-title').insertAdjacentHTML('afterend', '<div class="modal-desc"></div>');
    if (detail) overlay.querySelector('.modal-desc').textContent = detail;
    const buttons = choices.map(([value, label, primary]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `modal-btn ${primary ? 'confirm' : 'cancel'}`;
      button.textContent = label;
      button.addEventListener('click', () => close(value));
      return button;
    });
    overlay.querySelector('.modal-actions').append(...buttons);
    function close(value) {
      hideCenteredModal(overlay);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      resolve(value);
    }
    overlay.addEventListener('click', event => { if (event.target === overlay && dismissed !== null) close(dismissed); });
    overlay.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); if (dismissed !== null) close(dismissed); }
      if (event.key === 'Tab') {
        event.preventDefault();
        buttons[(buttons.indexOf(event.target) + 1) % buttons.length].focus();
      }
    });
    showCenteredModal(overlay);
    // The dialog takes focus, not a button, which would show a focus ring on open; Tab reaches them.
    overlay.querySelector('.modal-box').focus({ preventScroll: true });
  });
}
