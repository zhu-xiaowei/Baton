import { messageActionTargets, messageText, messageTextSelector } from './message-text.js';

export function refreshMessageCopy() {
  const container = document.querySelector('.messages');
  if (!container) return;
  const targets = new Set(messageActionTargets(container));
  for (const button of container.querySelectorAll('.message-copy')) {
    if (!targets.has(button.closest(messageTextSelector))) button.remove();
  }
  for (const node of targets) {
    if (node.querySelector('.message-copy')) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'message-copy message-action';
    button.textContent = 'Copy';
    button.title = 'Copy this message';
    button.setAttribute('aria-label', 'Copy message');
    (node.querySelector('.msg-meta') || node).append(button);
  }
}

export function initMessageCopy() {
  const pending = new WeakSet();
  const timers = new Map();
  let frame;
  let disposed = false;
  const schedule = () => {
    if (frame != null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      refreshMessageCopy();
    });
  };
  const click = async event => {
    const button = event.target.closest?.('.message-copy');
    const node = button?.closest(messageTextSelector);
    const container = node?.closest('.messages');
    if (!container || node.closest('[inert]')) return;
    event.preventDefault();
    event.stopPropagation();
    if (pending.has(button)) return;
    const text = messageText(node, container);
    if (!text.trim()) return;
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
    button.setAttribute('aria-label', label === 'Copied' ? 'Message copied' : 'Copy failed; try again');
    timers.set(button, setTimeout(() => {
      timers.delete(button);
      button.textContent = 'Copy';
      button.setAttribute('aria-label', 'Copy message');
    }, 2000));
  };
  const pointerdown = event => {
    if (event.target.closest?.('.message-copy')) event.preventDefault();
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.getElementById('content') || document.body,
    { childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ['data-message-id', 'data-native-id', 'data-turn-id', 'data-message-text'] });
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
    document.querySelectorAll('.message-copy').forEach(button => button.remove());
  };
}
