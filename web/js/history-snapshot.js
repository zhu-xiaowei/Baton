const METADATA_TYPES = new Set(['ai-title', 'custom-title', 'last-prompt']);

const LIVE_PROMPT_PREFIXES = ['live:user:', 'codex:user:'];

// Live prompts (noCache) reach DDB only after the JSONL/rollout watcher persists
// them under the same identity; keep them until the snapshot has them. Other
// live rows may persist under a different identity, so only prompts.
function unpersistedLiveTail(localMessages, snapshot) {
  let last = '';
  const ids = new Set();
  for (const message of snapshot) {
    if (!METADATA_TYPES.has(message.type) && (message.timestamp || '') > last) {
      last = message.timestamp;
    }
    if (message.uuid) ids.add('uuid:' + message.uuid);
    if (message.nativeId) ids.add('native:' + message.nativeId);
  }
  return localMessages.filter(message => message._strictLifecycle
    && LIVE_PROMPT_PREFIXES.some(prefix => String(message.nativeId || '').startsWith(prefix))
    && (message.timestamp || '') > last
    && !ids.has('uuid:' + message.uuid)
    && !(message.nativeId && ids.has('native:' + message.nativeId)));
}

export function replaceHistoryTail(localMessages, snapshot) {
  const result = replaceHistoryTailFromSnapshot(localMessages, snapshot);
  const liveTail = unpersistedLiveTail(localMessages, result.messages);
  if (liveTail.length) result.messages = result.messages.concat(liveTail);
  return result;
}

function replaceHistoryTailFromSnapshot(localMessages, snapshot) {
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
