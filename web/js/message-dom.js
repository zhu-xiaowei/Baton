import { attachTimelineTurn, messageSegments, turnTimeline } from './timeline.js';

function domKey(element) {
  if (!element) return '';
  var messageId = element.dataset?.messageId || '';
  var nativeId = element.dataset?.nativeId || '';
  var toolId = element.dataset?.toolId || '';
  if (messageId) return 'uuid:' + messageId + (toolId ? ':tool:' + toolId : '');
  if (nativeId) return 'native:' + nativeId + (toolId ? ':tool:' + toolId : '');
  if (toolId) return 'tool:' + toolId;
  if (element.classList?.contains('msg-user')) {
    return 'user:' + (element.dataset.anchor
      || element.dataset.messageId
      || element.dataset.nativeId
      || element.dataset.ts
      || '');
  }
  var firstIdentity = element.querySelector?.(
    '[data-message-id], [data-native-id], [data-tool-id]',
  );
  if (firstIdentity) return 'group:' + domKey(firstIdentity);
  return 'fallback:' + (element.className || '')
    + ':' + (element.dataset?.ts || '')
    + ':' + (element.textContent || '').trim();
}

function comparableMarkup(element) {
  var clone = element.cloneNode(true);
  var nodes = [clone].concat(Array.from(clone.querySelectorAll('*')));
  for (var node of nodes) {
    node.classList?.remove(
      'tool-details-collapsed',
      'expanded-desc',
      'expanded',
      'clamped',
      'open',
    );
    node.removeAttribute?.('aria-expanded');
    node.removeAttribute?.('data-tool-details-group');
    if (node.classList?.contains('tool-body-content')
      && String(node.id || '').indexOf('tool-') === 0) {
      node.removeAttribute('id');
    }
  }
  for (var button of clone.querySelectorAll('.clamp-btn')) button.remove();
  return clone.outerHTML;
}

function nodeUnchanged(current, expected) {
  if (!current || !expected || current.tagName !== expected.tagName) return false;
  return domKey(current) === domKey(expected)
    && comparableMarkup(current) === comparableMarkup(expected);
}

function sameUserAnchor(current, expected) {
  if (!current?.classList.contains('msg-user')
    || !expected?.classList.contains('msg-user')) {
    return false;
  }
  var currentAnchor = current.dataset?.anchor || '';
  var expectedAnchor = expected.dataset?.anchor || '';
  return !!currentAnchor && currentAnchor === expectedAnchor;
}

function syncUserIdentity(current, expected) {
  if (!current || !expected) return;
  for (var attribute of ['data-anchor', 'data-message-id', 'data-native-id']) {
    if (expected.hasAttribute(attribute)) {
      current.setAttribute(attribute, expected.getAttribute(attribute));
    }
  }
  if (expected.dataset?.ts) current.dataset.serverTs = expected.dataset.ts;
}

function inheritUiState(current, expected) {
  if (!current || !expected) return;
  if (current.classList.contains('thinking-tl')
    && expected.classList.contains('thinking-tl')) {
    var currentThinking = current.querySelector('.thinking-block');
    var expectedThinking = expected.querySelector('.thinking-block');
    if (currentThinking?.hasAttribute('data-thinking-duration-ms')
      && expectedThinking && !expectedThinking.hasAttribute('data-thinking-duration-ms')) {
      expectedThinking.dataset.thinkingDurationMs = currentThinking.dataset.thinkingDurationMs;
    }
  }
  if (current.classList.contains('tool-node')
    && expected.classList.contains('tool-node')
    && current.querySelector(':scope > .tool-header.tool-details-toggle')) {
    var collapsed = current.classList.contains('tool-details-collapsed');
    expected.classList.toggle('tool-details-collapsed', collapsed);
    var header = expected.querySelector(':scope > .tool-header');
    if (header?.classList.contains('tool-details-toggle')) {
      header.setAttribute('aria-expanded', String(!collapsed));
    }
  }
}

function syncElementInPlace(current, expected) {
  inheritUiState(current, expected);
  current.className = expected.className;
  for (var attribute of Array.from(current.attributes)) {
    if (attribute.name === 'class') continue;
    if (!expected.hasAttribute(attribute.name)) {
      current.removeAttribute(attribute.name);
    }
  }
  for (var expectedAttribute of Array.from(expected.attributes)) {
    if (expectedAttribute.name !== 'class') {
      current.setAttribute(expectedAttribute.name, expectedAttribute.value);
    }
  }
  current.innerHTML = expected.innerHTML;
  return current;
}

function assistantTurnsShareIdentity(current, expected) {
  if (!current?.classList.contains('assistant-turn')
    || !expected?.classList.contains('assistant-turn')) {
    return false;
  }
  var currentChildren = Array.from(current.children);
  for (var expectedChild of Array.from(expected.children)) {
    var expectedKey = domKey(expectedChild);
    if (expectedKey
      && expectedKey.indexOf('fallback:') !== 0
      && currentChildren.some(function (currentChild) {
        return domKey(currentChild) === expectedKey;
      })) {
      return true;
    }
    var toolId = expectedChild.dataset?.toolId || '';
    if (toolId && currentChildren.some(function (currentChild) {
      return currentChild.dataset?.toolId === toolId;
    })) {
      return true;
    }
  }
  return false;
}

function matchingStreamTurns(container, streamRow) {
  var turnId = streamRow?.dataset?.turnId || '';
  return Array.from(container.children).filter(function (element) {
    if (element === streamRow
      || !element.classList.contains('assistant-turn')
      || (element.dataset.timelineSegment || '') !== (streamRow.dataset.timelineSegment || '')) {
      return false;
    }
    var recoveredTurnId = element.dataset?.turnId || '';
    if (turnId && recoveredTurnId === turnId) return true;
    return !recoveredTurnId
      && assistantTurnsShareIdentity(streamRow, element);
  });
}

function streamChildrenCompatible(current, expected) {
  if (!current?.dataset?.blockId || !expected) return false;
  for (var className of ['assistant-text', 'thinking-tl', 'tool-node']) {
    if (current.classList.contains(className)
      || expected.classList.contains(className)) {
      return current.classList.contains(className)
        && expected.classList.contains(className);
    }
  }
  return false;
}

function reconcileChildren(parent, expectedParent, options = {}) {
  var existing = Array.from(parent.children);
  var used = new Set();
  var byKey = new Map();
  for (var element of existing) {
    var key = domKey(element);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(element);
  }

  var cursor = parent.firstElementChild;
  for (var expected of Array.from(expectedParent.children)) {
    var candidates = byKey.get(domKey(expected)) || [];
    var current = candidates.find(function (candidate) {
      return !used.has(candidate);
    }) || null;
    if (!current && expected.dataset?.toolId) {
      current = existing.find(function (candidate) {
        return !used.has(candidate)
          && candidate.dataset?.toolId === expected.dataset.toolId;
      }) || null;
    }
    if (!current
      && (parent.classList.contains('stream-preview')
        || parent.classList.contains('stream-committed'))) {
      current = existing.find(function (candidate) {
        return !used.has(candidate)
          && streamChildrenCompatible(candidate, expected);
      }) || null;
    }
    var resolved;
    if (current && nodeUnchanged(current, expected)) {
      used.add(current);
      resolved = current;
      if (!options.preserveUnmatched && resolved !== cursor) {
        parent.insertBefore(resolved, cursor);
      }
    } else if (current && options.preserveUnmatched) {
      used.add(current);
      resolved = syncElementInPlace(current, expected);
    } else {
      inheritUiState(current, expected);
      resolved = expected;
      parent.insertBefore(resolved, cursor);
      if (current) {
        used.add(current);
        current.remove();
      }
    }
    cursor = resolved.nextElementSibling;
  }

  if (!options.preserveUnmatched) {
    for (var stale of existing) {
      if (!used.has(stale) && stale.isConnected) stale.remove();
    }
  }
}

function reconcileTopLevel(container, expected) {
  var existing = Array.from(container.children);
  var used = new Set();
  var byKey = new Map();
  for (var element of existing) {
    var key = domKey(element);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(element);
  }

  var cursor = container.firstElementChild;
  for (var expectedElement of Array.from(expected.children)) {
    var key = domKey(expectedElement);
    var candidates = byKey.get(key) || [];
    var current = candidates.find(function (candidate) {
      return !used.has(candidate);
    }) || null;
    if (!current
      && expectedElement.classList.contains('assistant-turn')
      && expectedElement.dataset?.turnId) {
      current = existing.find(function (candidate) {
        return !used.has(candidate)
          && candidate.classList.contains('assistant-turn')
          && (candidate.dataset.timelineSegment || '') === (expectedElement.dataset.timelineSegment || '')
          && candidate.dataset?.turnId === expectedElement.dataset.turnId;
      }) || null;
    }
    if (!current && expectedElement.classList.contains('msg-user')) {
      current = existing.find(function (candidate) {
        return !used.has(candidate)
          && sameUserAnchor(candidate, expectedElement);
      }) || null;
    }
    var cursorKey = domKey(cursor);
    if (!current
      && cursor?.classList.contains('assistant-turn')
      && expectedElement.classList.contains('assistant-turn')
      && !cursor.dataset?.turnId
      && cursorKey.indexOf('group:uuid:') !== 0
      && !used.has(cursor)) {
      current = cursor;
    }

    var resolved;
    if (current && sameUserAnchor(current, expectedElement)) {
      used.add(current);
      syncUserIdentity(current, expectedElement);
      resolved = current;
    } else if (current?.classList.contains('assistant-turn')
      && expectedElement.classList.contains('assistant-turn')) {
      used.add(current);
      reconcileChildren(current, expectedElement);
      current.className = expectedElement.className;
      for (var attribute of ['data-turn-id', 'data-ts', 'data-timeline-segment']) {
        if (expectedElement.hasAttribute(attribute)) {
          current.setAttribute(attribute, expectedElement.getAttribute(attribute));
        } else {
          current.removeAttribute(attribute);
        }
      }
      resolved = current;
      if (resolved !== cursor) {
        container.insertBefore(resolved, cursor);
      }
    } else if (current && nodeUnchanged(current, expectedElement)) {
      used.add(current);
      resolved = current;
      if (resolved !== cursor) {
        container.insertBefore(resolved, cursor);
      }
    } else {
      inheritUiState(current, expectedElement);
      resolved = expectedElement;
      container.insertBefore(resolved, cursor);
      if (current) {
        used.add(current);
        current.remove();
      }
    }
    cursor = resolved.nextElementSibling;
  }

  for (var stale of existing) {
    if (!used.has(stale)
      && stale.isConnected
      && !stale.hasAttribute('data-pending-placeholder')
      && !stale.hasAttribute('data-pending')
      && !(stale.classList.contains('msg-user') && stale.dataset?.anchor)) {
      stale.remove();
    }
  }
}

function elementSegment(element, segments) {
  return segments.get('uuid:' + element.dataset.messageId)
    ?? segments.get('native:' + element.dataset.nativeId)
    ?? segments.get('tool:' + element.dataset.toolId);
}

function splitStreamRows(rows, segments, expected) {
  var groups = new Map(rows.map(row => [
    JSON.stringify([row.dataset.turnId, row.dataset.timelineSegment || '']), row,
  ]));
  for (var row of rows.slice()) {
    var timeline = turnTimeline(expected, row.dataset.turnId || '');
    for (var child of Array.from(row.children)) {
      var provisional = row.classList.contains('stream-preview')
        && !child.classList.contains('stream-block-committed')
        && child.dataset.blockId && !child.dataset.messageId
        && !child.dataset.nativeId && !child.dataset.toolId;
      var segment = elementSegment(child, segments)
        ?? (provisional && timeline.segment ? timeline.segment : row.dataset.timelineSegment || '');
      if (segment === (row.dataset.timelineSegment || '')) continue;
      var key = JSON.stringify([row.dataset.turnId, segment]);
      var target = groups.get(key);
      if (!target) {
        target = row.cloneNode(false);
        target.dataset.timelineSegment = segment;
        groups.set(key, target);
        rows.push(target);
      }
      target.appendChild(child);
    }
  }
  return rows.filter(row => {
    if (row.children.length) return true;
    row.remove();
    return false;
  });
}

function isMetadata(message) {
  return message?.type === 'ai-title'
    || message?.type === 'custom-title'
    || message?.type === 'last-prompt';
}

function changeAffectsDom(change) {
  var message = change?.after || change?.message || change?.incoming;
  if (!message || isMetadata(message)) return false;
  if (message.type === 'user'
    && typeof message.content === 'string'
    && /^\s*<subagent_notification>[\s\S]*<\/subagent_notification>\s*$/i
      .test(message.content)) {
    return false;
  }
  return true;
}

export function createMessageDom(options) {
  var state = options.state;
  var doc = options.document;
  var rendered = false;
  var configuredStreamTurnIds = new Set(options.streamTurnIds || []);

  function applyChanges(mergeResult) {
    var changed = (mergeResult.inserted || []).filter(changeAffectsDom).length
      + (mergeResult.patched || []).filter(changeAffectsDom).length
      + (mergeResult.identityUpdated || []).filter(changeAffectsDom).length;
    if (mergeResult.reordered) changed++;
    if (mergeResult.authoritative) changed++;
    if (!changed) return false;
    var container = doc.querySelector('.messages');
    if (!container || container.classList.contains('skeleton-messages')) {
      return false;
    }

    var olderLoader = container.querySelector(':scope > .loading-older');
    if (olderLoader) olderLoader.remove();
    var permissionPrompt = container.querySelector('#permission-prompt');
    if (permissionPrompt) permissionPrompt.remove();
    var pendingPlacements = Array.from(container.children)
      .filter(function (node) {
        return node.hasAttribute('data-pending');
      })
      .map(function (node) {
        var marker = doc.createElement('span');
        marker.hidden = true;
        marker.dataset.pendingPlaceholder = '1';
        node.before(marker);
        return { node: node, marker: marker };
      });
    var pendingNodes = pendingPlacements.map(function (placement) {
      return placement.node;
    });
    var streamRows = Array.from(container.children).filter(function (node) {
      return node.classList.contains('stream-preview')
        || node.classList.contains('stream-committed');
    });
    var streamPlacements = new Map();
    for (var streamNode of streamRows) {
      var streamMarker = doc.createElement('span');
      streamMarker.hidden = true;
      streamMarker.dataset.streamPlaceholder = '1';
      streamNode.before(streamMarker);
      streamPlacements.set(streamNode, streamMarker);
    }
    for (var node of pendingNodes.concat(streamRows)) node.remove();
    var streamedTurnIds = new Set(configuredStreamTurnIds);
    for (var previewTurnId of streamRows.filter(function (node) {
      return node.classList.contains('stream-preview');
    }).map(function (node) {
      return node.dataset?.turnId || '';
    }).filter(Boolean)) {
      streamedTurnIds.add(previewTurnId);
    }
    var segments = messageSegments(state.wsAllMessages);
    var streamedSegments = new Map();
    for (var streamRow of streamRows) {
      var covered = streamedSegments.get(streamRow.dataset.turnId) || new Set();
      covered.add(streamRow.dataset.timelineSegment || '');
      for (var child of Array.from(streamRow.children)) {
        var childSegment = elementSegment(child, segments);
        if (childSegment !== undefined) covered.add(childSegment);
      }
      streamedSegments.set(streamRow.dataset.turnId, covered);
    }
    var renderMessages = streamedTurnIds.size
      ? state.wsAllMessages.map(function (message) {
          var covered = streamedSegments.get(message.turnId);
          var segment = segments.get('uuid:' + message.uuid)
            ?? segments.get('native:' + message.nativeId) ?? '';
          if ((message?.type !== 'assistant' && message?.type !== 'summary')
            || !streamedTurnIds.has(message.turnId)
            || (covered && !covered.has(segment))) {
            return message;
          }
          return { ...message, _strictManaged: true };
        })
      : state.wsAllMessages;
    var expected = doc.createElement('div');
    expected.innerHTML = options.renderMessages(
      renderMessages,
      options.runtime(),
      { realtimeOrder: true },
    );
    streamRows = splitStreamRows(streamRows, segments, expected);
    reconcileTopLevel(container, expected);

    for (var placement of pendingPlacements) {
      if (placement.marker.isConnected) {
        placement.marker.replaceWith(placement.node);
      }
    }
    for (var streamRow of streamRows) {
      for (var recoveredTurn of matchingStreamTurns(
        container,
        streamRow,
      )) {
        if (streamRow.classList.contains('stream-committed')) {
          reconcileChildren(streamRow, recoveredTurn, {
            preserveUnmatched: true,
          });
        } else {
          for (var recoveredChild of Array.from(recoveredTurn.children)) {
            var recoveredKey = domKey(recoveredChild);
            var alreadyPresent = Array.from(streamRow.children).some(
              function (candidate) {
                return recoveredKey && domKey(candidate) === recoveredKey;
              },
            );
            if (!alreadyPresent) streamRow.appendChild(recoveredChild);
          }
        }
        recoveredTurn.remove();
      }
      var restored = attachTimelineTurn(container, streamRow);
      var streamPlacement = streamPlacements.get(streamRow);
      if (streamPlacement?.isConnected) {
        if (restored) streamPlacement.remove();
        else streamPlacement.replaceWith(streamRow);
      }
    }
    if (olderLoader) container.insertBefore(olderLoader, container.firstChild);
    if (permissionPrompt) container.appendChild(permissionPrompt);
    state.wsRenderedCount = state.wsAllMessages.length;
    rendered = true;
    return true;
  }

  function finalize() {
    options.updateTitleFromMessages?.();
    if (!rendered) return;
    var container = doc.querySelector('.messages');
    if (!container) return;
    options.markTurnAdjacency?.(container);
    options.loadImages?.(container);
    options.clampOverflow?.(container);
    options.renderMermaidBlocks?.(container);
    options.renderKatexBlocks?.(container);
  }

  return { applyChanges, finalize };
}
