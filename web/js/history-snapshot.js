export function replaceHistoryTail(localMessages, snapshot) {
  const boundary = snapshot[0];
  if (boundary) {
    for (const field of ['uuid', 'nativeId']) {
      if (!boundary[field]) continue;
      const matches = localMessages.reduce((indexes, message, index) => {
        if (message[field] === boundary[field] && message.type === boundary.type) {
          indexes.push(index);
        }
        return indexes;
      }, []);
      if (matches.length > 1) break;
      if (matches.length === 1) {
        const preservedCount = matches[0];
        return {
          messages: localMessages.slice(0, preservedCount).concat(snapshot),
          preservedCount,
        };
      }
    }
  }
  return { messages: snapshot.slice(), preservedCount: 0 };
}

function viewportKey(element) {
  const data = element.dataset;
  if (data.toolId) return 'tool:' + data.toolId;
  if (data.messageId) return 'message:' + data.messageId;
  if (data.anchor) return 'anchor:' + data.anchor;
  return 'native:' + data.nativeId;
}

const ANCHOR_SELECTOR = '[data-tool-id], [data-message-id], [data-anchor], [data-native-id]';

export function captureHistoryViewport(content) {
  const bounds = content.getBoundingClientRect();
  const anchor = Array.from(content.querySelectorAll(ANCHOR_SELECTOR))
    .find(element => {
      const rect = element.getBoundingClientRect();
      return rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom;
    });
  return {
    scrollTop: content.scrollTop,
    key: anchor ? viewportKey(anchor) : '',
    offset: anchor ? anchor.getBoundingClientRect().top - bounds.top : 0,
  };
}

export function restoreHistoryViewport(content, viewport) {
  const anchor = viewport.key && Array.from(content.querySelectorAll(ANCHOR_SELECTOR))
    .find(element => viewportKey(element) === viewport.key);
  content.scrollTop = viewport.scrollTop;
  if (anchor) {
    content.scrollTop += anchor.getBoundingClientRect().top
      - content.getBoundingClientRect().top - viewport.offset;
  }
}
