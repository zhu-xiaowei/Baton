// One transient message at the bottom of the screen, above every overlay.
let toast;
let timer;

export function showToast(text) {
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    toast.setAttribute('role', 'alert');
    document.body.append(toast);
  }
  toast.textContent = text;
  toast.classList.add('visible');
  clearTimeout(timer);
  timer = setTimeout(() => toast.classList.remove('visible'), 3000);
}
