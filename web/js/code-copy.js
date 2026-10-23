const blocks = '.messages .assistant-text pre';
const excluded = '.skeleton-copy, .summary-block, .command-panel-tl, .tool-node';

export function refreshCodeCopy() {
  document.querySelectorAll(blocks).forEach(pre => {
    if (pre.closest(excluded)) return;
    const code = pre.querySelector(':scope > code');
    const existing = pre.querySelector(':scope > .code-copy');
    if (!code?.textContent) {
      existing?.remove();
      return;
    }
    if (existing) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'code-copy message-action';
    button.textContent = 'Copy';
    button.setAttribute('aria-label', 'Copy code');
    button.title = 'Copy the code currently shown';
    pre.prepend(button);
  });
}

export function initCodeCopy() {
  const pending = new WeakSet();
  const timers = new Map();
  let disposed = false;
  let frame;
  const schedule = () => {
    if (frame != null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      refreshCodeCopy();
    });
  };
  const click = async event => {
    const button = event.target.closest?.('.code-copy');
    const pre = button?.parentElement;
    if (!pre?.matches(blocks) || pre.closest(excluded)) return;
    event.preventDefault();
    event.stopPropagation();
    if (pending.has(button)) return;
    const text = pre.querySelector(':scope > code')?.textContent;
    if (!text) return;
    pending.add(button);
    clearTimeout(timers.get(button));
    timers.delete(button);
    button.setAttribute('aria-busy', 'true');
    let label;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      label = 'Copied';
    } catch {
      label = 'Copy failed';
    } finally {
      pending.delete(button);
      button.removeAttribute('aria-busy');
    }
    if (disposed || !button.isConnected) return;
    button.textContent = label;
    button.setAttribute('aria-label', label === 'Copied' ? 'Code copied' : 'Copy failed; try again');
    timers.set(button, setTimeout(() => {
      timers.delete(button);
      button.textContent = 'Copy';
      button.setAttribute('aria-label', 'Copy code');
    }, 2000));
  };
  const pointerdown = event => {
    if (event.target.closest?.('.code-copy')) event.preventDefault();
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.getElementById('content') || document.body,
    { subtree: true, childList: true, characterData: true });
  document.addEventListener('click', click, true);
  document.addEventListener('pointerdown', pointerdown, true);
  schedule();
  return () => {
    disposed = true;
    observer.disconnect();
    if (frame != null) cancelAnimationFrame(frame);
    document.removeEventListener('click', click, true);
    document.removeEventListener('pointerdown', pointerdown, true);
    for (const timer of timers.values()) clearTimeout(timer);
    document.querySelectorAll('.code-copy').forEach(button => button.remove());
  };
}
