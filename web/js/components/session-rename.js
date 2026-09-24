import { state } from '../state.js';
import { requestWsRpc } from '../ws-rpc.js';
import { showCenteredModal, hideCenteredModal } from './modal-viewport.js';
import { setButtonLoading } from './loading.js';

export function openSessionRename(sessionId) {
  sessionId = sessionId || state.rootSessionId || state.appState.session;
  if (!sessionId || sessionId === '__new__' || !state.appState.project) return;
  if (document.getElementById('sessionRenameModal')) return;
  const target = {
    device: state.appState.device,
    projectHash: state.appState.project.hash,
    sessionId,
  };
  const previousFocus = document.activeElement;
  const overlay = document.createElement('div');
  overlay.id = 'sessionRenameModal';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = '<form class="modal-box" role="dialog" aria-modal="true" aria-labelledby="sessionRenameTitle">'
    + '<h2 class="modal-title" id="sessionRenameTitle">Rename session</h2>'
    + '<input id="sessionRenameInput" class="modal-input" type="text" maxlength="200" autocomplete="off" aria-label="New session name" placeholder="Enter a new name">'
    + '<div class="modal-error" role="alert"></div>'
    + '<div class="modal-actions"><button type="button" class="modal-btn cancel">Cancel</button>'
    + '<button type="submit" class="modal-btn confirm" disabled>Save</button></div></form>';
  const input = overlay.querySelector('input');
  const confirm = overlay.querySelector('.confirm');
  const cancel = overlay.querySelector('.cancel');
  const error = overlay.querySelector('.modal-error');
  let busy = false;
  function close() {
    if (busy) return;
    hideCenteredModal(overlay);
    overlay.remove();
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    else document.querySelector('.session-rename-button')?.focus({ preventScroll: true });
  }
  input.addEventListener('input', function () {
    confirm.disabled = !input.value.trim();
    error.textContent = '';
  });
  cancel.addEventListener('click', close);
  overlay.addEventListener('click', function (event) {
    if (event.target === overlay) close();
  });
  overlay.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key !== 'Tab') return;
    const controls = [...overlay.querySelectorAll('input, button')].filter(control => !control.disabled);
    if (!controls.length) { event.preventDefault(); return; }
    const next = event.shiftKey ? controls.at(-1) : controls[0];
    const edge = event.shiftKey ? controls[0] : controls.at(-1);
    if (document.activeElement === edge) { event.preventDefault(); next.focus(); }
  });
  overlay.querySelector('form').addEventListener('submit', async function (event) {
    event.preventDefault();
    const name = input.value.trim();
    if (busy || !name) return;
    if (/[\r\n\x00-\x1f\x7f]/.test(name)) {
      error.textContent = 'Enter a name on one line.';
      return;
    }
    busy = true;
    input.disabled = cancel.disabled = confirm.disabled = true;
    setButtonLoading(confirm, 'Saving');
    try {
      if (typeof window.wsSendReliable !== 'function') await window.loadViewerLibs();
      const result = await requestWsRpc({ action: 'rename_session', ...target, name }, { timeout: 30000 });
      window.applySessionTitle({ ...target, name: result.name });
      busy = false;
      if (result.synced === false) {
        error.textContent = 'Native name saved. List sync failed; retry Save to synchronize.';
      } else {
        close();
      }
    } catch (failure) {
      error.textContent = failure.message || 'Could not rename session.';
    } finally {
      busy = false;
      input.disabled = cancel.disabled = confirm.disabled = false;
      setButtonLoading(confirm);
      if (overlay.isConnected) input.focus({ preventScroll: true });
    }
  });
  showCenteredModal(overlay);
  input.focus({ preventScroll: true });
}
