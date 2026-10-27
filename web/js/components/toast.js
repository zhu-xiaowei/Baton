// One transient message at the bottom of the screen, above every overlay.
let toast;
let timer;

// `bottom` is the gap in px above the bottom safe area.
export function showToast(text, { bottom = 40 } = {}) {
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    toast.setAttribute('role', 'alert');
    document.body.append(toast);
  }
  toast.textContent = text;
  toast.style.bottom = `calc(${bottom}px + var(--sab, env(safe-area-inset-bottom, 0px)))`;
  toast.classList.add('visible');
  clearTimeout(timer);
  timer = setTimeout(() => toast.classList.remove('visible'), 3000);
}
