import { messageText } from './message-text.js';

const COPY_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>';
const COPIED_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const FAILED_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg>';

export function copyButtonHtml(kind) {
  const label = kind === 'code' ? 'Copy code' : kind === 'mermaid' ? 'Copy source' : kind === 'turn' ? 'Copy complete response' : 'Copy message';
  const handler = kind === 'code' ? 'copyCodeBlock' : kind === 'mermaid' ? 'copyMermaidSource' : 'copyMessage';
  return `<button type="button" class="copy-action message-action ${kind === 'turn' ? 'message-copy response-copy' : kind + '-copy'}" title="${label}" aria-label="${label}" aria-live="polite" onclick="event.stopPropagation();${handler}(this)">${COPY_ICON}</button>`;
}

export function refreshMessageCopy(container, { running = false } = {}) {
  if (!container) return false;
  let changed = false;
  // Only the latest completed answer may expose a response action.
  const row = [...container.children].filter(node =>
    node.matches('.assistant-turn, .msg-user, .msg-system-event') && !node.hidden).at(-1);
  const item = row?.matches('.assistant-turn:not(.stream-preview)')
    ? [...row.children].filter(node => node.classList.contains('tl-item')).at(-1) : null;
  let tail = item?.lastElementChild;
  if (tail?.classList.contains('response-copy')) tail = tail.previousElementSibling;
  while (tail?.matches('.md-seg, ul, ol') || (tail?.tagName === 'LI' && tail.lastElementChild?.matches('p, ul, ol'))) {
    tail = tail.lastElementChild;
  }
  // Prose (including a list item's text) can share its last line; other Markdown blocks use a trailing control.
  const inline = tail?.tagName === 'P' || (tail?.tagName === 'LI'
    && !tail.lastElementChild?.matches('div, pre, table, blockquote, hr, h1, h2, h3, h4, h5, h6, details, .katex-display, .katex-ph[data-d="1"]'));
  const target = !running && item?.matches('.assistant-text[data-message-text]') && item.dataset.messageText.trim()
    ? (inline ? tail : item) : null;
  for (const button of container.querySelectorAll('.response-copy')) {
    if (button.parentElement === target) continue;
    const parent = button.parentElement;
    button.remove();
    parent.classList.remove('copy-tail');
    if (!parent.className) parent.removeAttribute('class');
    changed = true;
  }
  if (target && !target.querySelector(':scope > .response-copy')) {
    target.classList.add('copy-tail');
    target.insertAdjacentHTML('beforeend', copyButtonHtml('turn'));
    changed = true;
  }
  return changed;
}

export function installCopyActions(view) {
  if (view.copyButtonHtml) return;
  const states = new WeakMap();
  async function copyText(button, text) {
    if (!text || button.closest('[inert]')) return;
    let state = states.get(button);
    if (!state) {
      state = { label: button.getAttribute('aria-label'), timer: null, pending: false };
      states.set(button, state);
    }
    if (state.pending) return;
    state.pending = true;
    view.clearTimeout(state.timer);
    button.setAttribute('aria-busy', 'true');
    let copied = false;
    try {
      if (!view.navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await view.navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      // Keep failure visible and retryable, including unavailable WebView clipboard access.
    } finally {
      state.pending = false;
      button.removeAttribute('aria-busy');
    }
    if (!button.isConnected) return;
    button.innerHTML = copied ? COPIED_ICON : FAILED_ICON;
    button.classList.toggle('copied', copied);
    button.classList.toggle('copy-failed', !copied);
    const label = copied ? 'Copied' : 'Copy failed; try again';
    button.setAttribute('aria-label', label);
    button.title = label;
    state.timer = view.setTimeout(() => {
      button.innerHTML = COPY_ICON;
      button.classList.remove('copied', 'copy-failed');
      button.setAttribute('aria-label', state.label);
      button.title = state.label;
    }, 1500);
  }
  view.copyButtonHtml = copyButtonHtml;
  view.copyCodeBlock = button => copyText(button,
    button.closest('.code-block')?.querySelector('pre > code')?.textContent);
  view.copyMermaidSource = button => copyText(button,
    button.closest('.mermaid-block')?.querySelector('.mermaid-src')?.textContent);
  view.copyMessage = button => {
    const node = button.closest('.msg-user, .assistant-turn, .tl-item.assistant-text');
    const container = node?.closest('.messages');
    if (container) return copyText(button, messageText(node, container));
  };
  view.document.addEventListener('pointerdown', event => {
    if (event.target.closest?.('.copy-action')) event.preventDefault();
  }, true);
}

if (typeof window !== 'undefined') installCopyActions(window);
