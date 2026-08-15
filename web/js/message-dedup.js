function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  const block = message.content.find((item) => item?.type === 'text');
  return block?.text || '';
}

function codexUserIdentity(nativeId) {
  const value = String(nativeId || '');
  if (/^codex:turn:.+:user$/.test(value)) return 'turn';
  if (/^codex:user:.+/.test(value)) return 'client';
  return '';
}

function duplicatePair(left, right) {
  if (left?.type !== 'user' || right?.type !== 'user') return false;
  const leftKind = codexUserIdentity(left.nativeId);
  const rightKind = codexUserIdentity(right.nativeId);
  if (!leftKind || !rightKind || leftKind === rightKind) return false;
  if (messageText(left).trim() !== messageText(right).trim()) return false;
  const leftAt = Date.parse(left.timestamp || '');
  const rightAt = Date.parse(right.timestamp || '');
  return Number.isFinite(leftAt) && Number.isFinite(rightAt)
    && Math.abs(leftAt - rightAt) <= 100;
}

export function dedupeCodexUserMessages(messages) {
  const output = [];
  for (const message of messages || []) {
    let duplicateIndex = -1;
    for (let index = output.length - 1; index >= 0 && index >= output.length - 3; index--) {
      if (duplicatePair(output[index], message)) {
        duplicateIndex = index;
        break;
      }
    }
    if (duplicateIndex === -1) {
      output.push(message);
      continue;
    }
    // The client-scoped event is canonical: its identity matches send acks and
    // stream anchors, while the turn-scoped row is Codex's earlier mirror.
    if (codexUserIdentity(message.nativeId) === 'client') {
      output[duplicateIndex] = message;
    }
  }
  return output;
}
