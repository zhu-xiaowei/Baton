export const messageTextSelector = '.msg-user, .tl-item.assistant-text';

export function messageTextNodes(container) {
  return [...container.querySelectorAll(messageTextSelector)]
    .filter(node => !node.closest('.skeleton-copy, .summary-block, .command-panel-tl, .tool-node'));
}

function identity(node) {
  if (node.classList.contains('msg-user')) return node;
  const turn = node.closest('[data-turn-id]')?.dataset.turnId || '';
  if (node.dataset.messageId) return JSON.stringify([turn, 'message', node.dataset.messageId]);
  if (node.dataset.nativeId) return JSON.stringify([turn, 'native', node.dataset.nativeId]);
  return turn && node.dataset.blockId
    ? JSON.stringify([turn, 'block', node.dataset.blockId]) : node;
}

function ownText(node) {
  return node.classList.contains('msg-user')
    ? node.querySelector('.msg-text')?.textContent || ''
    : node.dataset.messageText || '';
}

export function messageText(node, container) {
  const key = identity(node);
  return messageTextNodes(container)
    .filter(item => identity(item) === key)
    .map(ownText).filter(Boolean).join('\n\n');
}

export function messageActionTargets(container) {
  const last = new Map();
  const hasText = new Set();
  for (const node of messageTextNodes(container)) {
    const key = identity(node);
    last.set(key, node);
    if (ownText(node).trim()) hasText.add(key);
  }
  return [...last].filter(([key]) => hasText.has(key)).map(([, node]) => node);
}
