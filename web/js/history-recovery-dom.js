/**
 * @param {{state: object, document: Document, runtime: Function, renderMessages: Function, preserveStreamPreviews?: boolean, preserveUnmatchedHistory?: boolean, isCurrentBarrier?: Function, promotePending?: Function, reportConflict?: Function, releaseBarrier?: Function, applyStreamOperations?: Function, discardStreamTurn?: Function, markTurnAdjacency?: Function, loadImages?: Function, clampOverflow?: Function, renderMermaidBlocks?: Function, renderKatexBlocks?: Function, updateTitleFromMessages?: Function, markSpinnerTurnEnd?: Function, updateSendBtn?: Function, updateSpinner?: Function}} options
 * @returns {{setMessages: Function, applyHistoryChanges: Function, applyActivity: Function, finalize: Function}}
 */
export function createHistoryRecoveryDomAdapter(options = {}) {
  return buildHistoryRecoveryDomAdapter(options);
}

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
  if (current.classList.contains('tool-node')
    && expected.classList.contains('tool-node')) {
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

function recoveredTurnsForStream(container, streamRow) {
  var turnId = streamRow?.dataset?.turnId || '';
  return Array.from(container.children).filter(function (element) {
    if (element === streamRow
      || !element.classList.contains('assistant-turn')) {
      return false;
    }
    var recoveredTurnId = element.dataset?.turnId || '';
    if (turnId && recoveredTurnId === turnId) return true;
    return !recoveredTurnId
      && assistantTurnsShareIdentity(streamRow, element);
  });
}

function streamRowHasVisibleContent(streamRow) {
  if (!streamRow) return false;
  return Array.from(streamRow.children).some(function (child) {
    if ((child.textContent || '').trim()) return true;
    if (child.classList?.contains('tool-node')) return true;
    return !!child.querySelector?.(
      'img,video,audio,canvas,svg,pre,code,table',
    );
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
    var matchedStreamBlock = false;
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
      matchedStreamBlock = !!current;
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
    } else if (current && matchedStreamBlock) {
      used.add(current);
      resolved = syncElementInPlace(current, expected);
      if (!options.preserveUnmatched && resolved !== cursor) {
        parent.insertBefore(resolved, cursor);
      }
    } else if (current
      && parent.classList.contains('stream-committed')
      && domKey(current) === domKey(expected)) {
      used.add(current);
      resolved = syncElementInPlace(current, expected);
      if (!options.preserveUnmatched && resolved !== cursor) {
        parent.insertBefore(resolved, cursor);
      }
    } else {
      inheritUiState(current, expected);
      resolved = expected;
      if (options.preserveUnmatched && current) {
        current.before(resolved);
      } else {
        parent.insertBefore(resolved, cursor);
      }
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

function reconcileTopLevel(container, expected, options = {}) {
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
          && candidate.dataset?.turnId === expectedElement.dataset.turnId;
      }) || null;
    }
    if (!current
      && options.preserveUnmatched
      && expectedElement.classList.contains('assistant-turn')) {
      current = existing.find(function (candidate) {
        return !used.has(candidate)
          && assistantTurnsShareIdentity(candidate, expectedElement);
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
      && !options.preserveUnmatched
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
      var wasStreamCommitted =
        current.classList.contains('stream-committed');
      reconcileChildren(current, expectedElement, {
        preserveUnmatched: !!options.preserveUnmatched,
      });
      current.className = expectedElement.className;
      if (wasStreamCommitted) current.classList.add('stream-committed');
      for (var attribute of ['data-turn-id', 'data-ts']) {
        if (expectedElement.hasAttribute(attribute)) {
          current.setAttribute(attribute, expectedElement.getAttribute(attribute));
        } else {
          current.removeAttribute(attribute);
        }
      }
      resolved = current;
      if (!options.preserveUnmatched && resolved !== cursor) {
        container.insertBefore(resolved, cursor);
      }
    } else if (current && nodeUnchanged(current, expectedElement)) {
      used.add(current);
      resolved = current;
      if (!options.preserveUnmatched && resolved !== cursor) {
        container.insertBefore(resolved, cursor);
      }
    } else if (current && options.preserveUnmatched) {
      used.add(current);
      resolved = syncElementInPlace(current, expectedElement);
    } else {
      inheritUiState(current, expectedElement);
      resolved = expectedElement;
      if (options.preserveUnmatched && current) {
        current.before(resolved);
      } else {
        container.insertBefore(resolved, cursor);
      }
      if (current) {
        used.add(current);
        current.remove();
      }
    }
    cursor = resolved.nextElementSibling;
  }

  if (!options.preserveUnmatched) {
    for (var stale of existing) {
      if (!used.has(stale)
        && stale.isConnected
        && !stale.hasAttribute('data-recovery-pending-placeholder')
        && !stale.hasAttribute('data-pending')
        && !(stale.classList.contains('msg-user') && stale.dataset?.anchor)) {
        stale.remove();
      }
    }
  }
}

function restoreStreamPreview(container, streamPreview) {
  var turnId = streamPreview?.dataset?.turnId || '';
  var anchor = turnId
    ? Array.from(container.children).find(function (element) {
        return element.dataset?.anchor === turnId;
      })
    : null;
  if (!anchor) {
    return false;
  }
  var insertionPoint = anchor;
  while (insertionPoint.nextElementSibling?.classList.contains('assistant-turn')
    && insertionPoint.nextElementSibling !== streamPreview) {
    insertionPoint = insertionPoint.nextElementSibling;
  }
  insertionPoint.insertAdjacentElement('afterend', streamPreview);
  return true;
}

function rebuildMessageIndex(messages) {
  var index = new Set();
  for (var message of messages) {
    if (message?.uuid) index.add(message.uuid);
    for (var alias of message?.identityAliases || []) {
      if (!/^(?:turn|pending):/.test(String(alias))) index.add(String(alias));
    }
    if (!message?.uuid && message?.nativeId) {
      index.add('native:' + message.nativeId);
    }
  }
  return index;
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

function buildHistoryRecoveryDomAdapter(options) {
  var state = options.state;
  var doc = options.document;
  var rendered = false;
  var configuredStreamTurnIds = new Set(options.streamTurnIds || []);

  function setMessages(messages) {
    state.wsAllMessages = messages;
    state.wsMessageUuids = rebuildMessageIndex(messages);
    state.wsMessageCount = messages.length;
    state.wsLastTimestamp = messages.length
      ? messages[messages.length - 1].timestamp || ''
      : '';
  }

  function applyHistoryChanges(mergeResult, pendingResult, activity) {
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
        marker.dataset.recoveryPendingPlaceholder = '1';
        node.before(marker);
        return { node: node, marker: marker };
      });
    var pendingNodes = pendingPlacements.map(function (placement) {
      return placement.node;
    });
    var allStreamRows = Array.from(container.children).filter(function (node) {
      return node.classList.contains('stream-preview')
        || node.classList.contains('stream-committed');
    });
    var preserveStreamPreviews = activity !== 'completed'
      || !!options.preserveStreamPreviews
      || !!options.preserveUnmatchedHistory
      || configuredStreamTurnIds.size > 0;
    var streamRows = allStreamRows.filter(function (node) {
      return node.classList.contains('stream-committed')
        || preserveStreamPreviews
        || streamRowHasVisibleContent(node);
    });
    var streamPlacements = new Map();
    for (var streamNode of allStreamRows) {
      var streamMarker = doc.createElement('span');
      streamMarker.hidden = true;
      streamMarker.dataset.recoveryStreamPlaceholder = '1';
      streamNode.before(streamMarker);
      streamPlacements.set(streamNode, streamMarker);
    }
    if (!preserveStreamPreviews) {
      for (var stalePreview of allStreamRows) {
        if (!stalePreview.classList.contains('stream-preview')) continue;
        if (streamRows.includes(stalePreview)) continue;
        var staleTurnId = stalePreview.dataset?.turnId || '';
        if (staleTurnId) options.discardStreamTurn?.(staleTurnId);
      }
    }
    for (var node of pendingNodes.concat(allStreamRows)) node.remove();
    for (var removedStreamRow of allStreamRows) {
      if (!streamRows.includes(removedStreamRow)) {
        streamPlacements.get(removedStreamRow)?.remove();
      }
    }

    var streamedTurnIds = new Set(configuredStreamTurnIds);
    for (var previewTurnId of streamRows.filter(function (node) {
      return node.classList.contains('stream-preview');
    }).map(function (node) {
      return node.dataset?.turnId || '';
    }).filter(Boolean)) {
      streamedTurnIds.add(previewTurnId);
    }
    var renderMessages = streamedTurnIds.size
      ? state.wsAllMessages.map(function (message) {
          if ((message?.type !== 'assistant' && message?.type !== 'summary')
            || !streamedTurnIds.has(message.turnId)) {
            return message;
          }
          return { ...message, _strictManaged: true };
        })
      : state.wsAllMessages;
    var expected = doc.createElement('div');
    expected.innerHTML = options.renderMessages(
      renderMessages,
      options.runtime(),
      {
        ...(options.renderOptions || {}),
      },
    );
    reconcileTopLevel(container, expected, {
      preserveUnmatched: !!options.preserveUnmatchedHistory,
    });

    for (var placement of pendingPlacements) {
      if (placement.marker.isConnected) {
        placement.marker.replaceWith(placement.node);
      }
    }
    for (var streamRow of streamRows) {
      for (var recoveredTurn of recoveredTurnsForStream(
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
      var restored = restoreStreamPreview(container, streamRow);
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

  function applyActivity(activity) {
    var wasRunning = state.wsRunning;
    state.wsRunning = activity === 'running';
    if (wasRunning && activity === 'completed') {
      options.markSpinnerTurnEnd?.();
    }
    options.updateSendBtn?.();
    options.updateSpinner?.();
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

  return {
    isCurrentBarrier: options.isCurrentBarrier,
    setMessages: setMessages,
    promotePending: options.promotePending,
    applyHistoryChanges: applyHistoryChanges,
    reportConflict: options.reportConflict,
    setPendingMessages: function (pending) {
      state.pendingSentMessages = pending;
    },
    releaseBarrier: options.releaseBarrier,
    applyStreamOperations: options.applyStreamOperations,
    applyActivity: applyActivity,
    finalize: finalize,
  };
}
