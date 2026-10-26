export const messageTextSelector = '.msg-user, .tl-item.assistant-text';

function textNodes(container) {
  return [...container.querySelectorAll(messageTextSelector)]
    .filter(node => !node.closest('.skeleton-copy, .summary-block, .command-panel-tl, .tool-node'));
}

function identity(node) {
  if (node.classList.contains('msg-user')) return node;
  const turn = node.closest('.assistant-turn');
  if (turn?.dataset.turnId) return 'turn:' + turn.dataset.turnId;
  if (!turn) return node;
  let first = turn;
  for (let previous = turn.previousElementSibling; previous; previous = previous.previousElementSibling) {
    if (previous.classList.contains('msg-user')) break;
    if (previous.classList.contains('assistant-turn')) first = previous;
  }
  return first;
}

function ownText(node) {
  return node.classList.contains('msg-user')
    ? node.querySelector('.msg-text')?.textContent || ''
    : node.dataset.messageText || '';
}

export function messageText(node, container) {
  const key = identity(node);
  return textNodes(container).filter(item => identity(item) === key)
    .map(ownText).filter(Boolean).join('\n\n');
}
