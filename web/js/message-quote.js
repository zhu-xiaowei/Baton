import { state } from './state.js';

import { messageTextSelector as selector, messageTextNodes as candidates,
  messageActionTargets, messageText as messageQuoteText } from './message-text.js';

export { messageQuoteText };
const quotes = new Map();

function sessionKey() {
  return JSON.stringify([state.SERVER, state.appState.device,
    state.appState.project?.hash, state.appState.session, state.activeThreadId]);
}

function canQuote(input) {
  return input && !input.disabled && !input.readOnly && !input.closest('[inert]')
    && state.appState.session && state.activeThreadCanSend !== false;
}

function refreshRemoveButton() {
  const input = document.getElementById('msg-input');
  const bar = document.getElementById('input-bar');
  if (!input || !bar) return;
  const quote = quotes.get(sessionKey());
  let remove = bar.querySelector('.remove-message-quote');
  if (!quote || !input.value.startsWith(quote)) {
    remove?.remove();
    return;
  }
  if (!remove) {
    remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-message-quote';
    remove.textContent = 'Remove quote ×';
    bar.prepend(remove);
  }
}

export function refreshMessageQuotes() {
  const container = document.querySelector('.messages');
  if (container) {
    const nodes = candidates(container);
    const targets = new Set(messageActionTargets(container));
    for (const node of nodes) {
      const existing = node.querySelector('.message-quote');
      if (!targets.has(node)) {
        existing?.remove();
        continue;
      }
      if (existing) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'message-quote message-action';
      button.textContent = 'Quote';
      button.title = 'Quote this message in your draft';
      (node.querySelector('.msg-meta') || node).append(button);
    }
  }
  refreshRemoveButton();
}

export function initMessageQuotes() {
  let frame;
  const schedule = () => {
    if (frame != null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      refreshMessageQuotes();
    });
  };
  const click = event => {
    const button = event.target.closest?.('.message-quote, .remove-message-quote');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const input = document.getElementById('msg-input');
    if (!canQuote(input)) return;
    const key = sessionKey();
    const previous = quotes.get(key);
    const draft = previous && input.value.startsWith(previous)
      ? input.value.slice(previous.length) : input.value;
    if (button.classList.contains('remove-message-quote')) {
      if (!previous || !input.value.startsWith(previous)) return;
      input.value = draft;
      quotes.delete(key);
    } else {
      const node = button.closest(selector);
      const text = messageQuoteText(node, node.closest('.messages'));
      if (!text.trim()) return;
      const author = node.classList.contains('msg-user') ? 'You' : 'Assistant';
      const quote = `> ${author}:\n${text.split('\n').map(line => '> ' + line).join('\n')}\n\n`;
      input.value = quote + draft;
      quotes.delete(key);
      quotes.set(key, quote);
      if (quotes.size > 100) quotes.delete(quotes.keys().next().value);
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
    input.scrollTop = input.scrollHeight;
    refreshRemoveButton();
  };
  const pointerdown = event => {
    if (event.target.closest?.('.message-quote, .remove-message-quote')) event.preventDefault();
  };
  document.addEventListener('click', click, true);
  document.addEventListener('pointerdown', pointerdown, true);
  document.addEventListener('input', refreshRemoveButton);
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ['data-message-id', 'data-native-id', 'data-turn-id', 'data-message-text'] });
  schedule();
  return () => {
    observer.disconnect();
    if (frame != null) cancelAnimationFrame(frame);
    document.removeEventListener('click', click, true);
    document.removeEventListener('pointerdown', pointerdown, true);
    document.removeEventListener('input', refreshRemoveButton);
    quotes.clear();
  };
}
