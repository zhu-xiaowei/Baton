import { state } from '../state.js';

let pendingOpen = null;

export function openAttachmentPicker() {
  const picker = document.getElementById('img-picker');
  const button = document.querySelector('.img-btn');
  const bar = document.getElementById('input-bar');
  if (!picker || !button || button.disabled || bar?.inert) return;
  if (pendingOpen) return pendingOpen;

  const viewport = window.visualViewport;
  const keyboardOpen = () => bar?.classList.contains('kb-up')
    || (viewport && viewport.height < window.innerHeight * 0.75);
  const mobile = document.documentElement.classList.contains('native-mobile');
  if (!mobile || !keyboardOpen()) {
    picker.click();
    return;
  }

  // iOS anchors its file-source menu before dismissing the keyboard. Wait for
  // that dismissal to settle so the menu uses the button's final position.
  const session = state.appState.session;
  const device = state.appState.device;
  const project = state.appState.project?.hash;
  pendingOpen = new Promise(resolve => {
    let quietTimer;
    let deadlineTimer;
    const finish = () => {
      clearTimeout(quietTimer);
      clearTimeout(deadlineTimer);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      pendingOpen = null;
      const sameSession = state.appState.session === session
        && state.appState.device === device
        && state.appState.project?.hash === project;
      if (sameSession && picker.isConnected && !button.disabled
        && !bar?.inert && bar?.getClientRects().length && !document.hidden) {
        window.syncMobileViewport?.();
        picker.click();
      }
      resolve();
    };
    const checkSettled = () => {
      if (keyboardOpen()) quietTimer = setTimeout(checkSettled, 80);
      else finish();
    };
    function schedule() {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(checkSettled, 120);
    }
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    // Some WebViews omit the final viewport event; never leave the picker stuck.
    deadlineTimer = setTimeout(finish, 900);
    quietTimer = setTimeout(checkSettled, 250);
    const input = document.getElementById('msg-input');
    if (document.activeElement === input) input.blur();
  });
  return pendingOpen;
}
