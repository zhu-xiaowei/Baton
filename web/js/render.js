import './components/tool-run-group.js';

// Message rendering orchestrator
(function () {
  window.registerToolRunGroup({
    kind: 'codex-explore',
    itemClass: 'codex-explore',
    classPrefix: 'codex-explore',
  });
  window.registerToolRunGroup({
    kind: 'codex-ran',
    itemClass: 'codex-ran',
    classPrefix: 'codex-ran',
  });
  window.registerToolRunGroup({
    kind: 'codex-called',
    itemClass: 'codex-called',
    classPrefix: 'codex-called',
  });
  window.registerToolRunGroup({
    kind: 'claude-bash',
    itemClass: 'claude-bash',
    classPrefix: 'claude-bash',
  });

  function escapeAttribute(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  window.markCodexExploreGroups = window.markToolRunGroups;

  window.normalizeCodexWaitGroups = function (container) {
    if (!container) return;
    let previousWait = null;
    for (const row of Array.from(container.children)) {
      if (!row.classList?.contains('assistant-turn')) {
        previousWait = null;
        continue;
      }
      for (const item of Array.from(row.children)) {
        if (!item.classList?.contains('codex-terminal-wait')) {
          previousWait = null;
          continue;
        }
        if (previousWait) {
          const previousRow = previousWait.parentElement;
          previousWait.remove();
          if (previousRow?.classList.contains('assistant-turn')
            && !previousRow.children.length) {
            previousRow.remove();
          }
        }
        previousWait = item;
      }
    }
  };

  window.normalizeCodexTimeline = function (container) {
    if (!container) return;
    window.normalizeCodexWaitGroups(container);
    let historicalPlans = [];
    for (const row of Array.from(container.children)) {
      if (!row.classList?.contains('assistant-turn')) {
        historicalPlans = [];
        continue;
      }
      const rowPlans = Array.from(row.children).filter(item =>
        item.dataset?.codexPlan === '1');
      if ((row.classList.contains('stream-preview')
          || row.classList.contains('stream-committed'))
        && rowPlans.length) {
        for (let count = rowPlans.length;
          count > 0 && historicalPlans.length;
          count--) {
          const duplicate = historicalPlans.pop();
          const duplicateRow = duplicate.parentElement;
          duplicate.remove();
          if (duplicateRow?.classList.contains('assistant-turn')
            && !duplicateRow.children.length) {
            duplicateRow.remove();
          }
        }
      } else {
        historicalPlans.push(...rowPlans);
      }
    }
    window.markCodexExploreGroups(container);
  };

  function buildToolMaps(messages) {
    const resultMap = {};
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
      const msg = messages[messageIndex];
      if (!Array.isArray(msg.content)) continue;
      for (const b of msg.content) {
        if (b.type === 'tool_result' && b.tool_use_id) {
          if (b.codexSuperseded) continue;
          resultMap[b.tool_use_id] = {
            ...b,
            ...(msg.toolUseResult
              ? { _agentMeta: msg.toolUseResult }
              : {}),
            _timestamp: msg.timestamp || '',
            _messageIndex: messageIndex,
          };
        }
      }
    }
    return resultMap;
  }

  // Convert one assistant message into an array of tl-item objects
  function extractItems(msg, resultMap, runtime, options = {}) {
    const items = [];
    if (msg._commandPanel?.type === 'claude-usage' && window.renderClaudeUsagePanel) {
      items.push({ type: 'panel', html: renderClaudeUsagePanel(msg._commandPanel) });
      return items;
    }
    if (!Array.isArray(msg.content)) {
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (text) items.push({ type: 'text', html: renderAssistantText(text) });
      return items;
    }

    let textBuf = [];
    for (let blockIndex = 0; blockIndex < msg.content.length; blockIndex++) {
      const block = msg.content[blockIndex];
      if (block.type === 'text') {
        if (block.text && block.text.trim()) textBuf.push(block.text);
      } else if (block.type === 'thinking') {
        flush();
        items.push({ type: 'thinking', html: renderThinking(block) });
      } else if (block.type === 'tool_use') {
        const result = resultMap[block.id] || null;
        if (runtime === 'codex' && window.isCodexHiddenTool?.(block, result)) continue;
        flush();
        window._lastToolState = '';
        window._lastToolHasDetails = false;
        const html = renderToolNode(block, result, runtime, {
          collapsed: !!options.collapseToolDetails,
        });
        const emptyTerminalWait = runtime === 'codex'
          && block.name === 'WriteStdin'
          && !String(block.input?.chars || '').length;
        const codexCalled = runtime === 'codex'
          && !!window.isCodexMcpTool?.(block, result);
        const codexExplore = runtime === 'codex'
          && !codexCalled
          && !!window.isCodexExploreTool?.(block, result);
        items.push({
          type: 'tool',
          state: window._lastToolState || '',
          toolDetails: !!window._lastToolHasDetails,
          html,
          toolId: block.id,
          codexCalled,
          codexExplore,
          codexRan: runtime === 'codex'
            && block.name === 'Bash'
            && !codexCalled
            && !codexExplore,
          claudeBash: runtime === 'claude' && block.name === 'Bash',
          codexWait: emptyTerminalWait,
          codexProcessId: String(result?.codexProcessId || block.input?.session_id || ''),
          codexBackgroundComplete: result?.codexBackground === 'complete',
          codexPlan: runtime === 'codex' && block.name === 'TodoWrite',
          displayOrder: result?.codexBackground === 'complete'
            ? Number(result._messageIndex)
            : Number(options.messageIndex),
          blockIndex,
        });
      } else if (block.type === 'image' && block.key) {
        flush();
        items.push({ type: 'text', html: `<div class="img-placeholder" data-key="${block.key}"><svg class="img-spinner" viewBox="0 0 36 36"><circle cx="18" cy="18" r="14" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="3"/><circle cx="18" cy="18" r="14" fill="none" stroke="#8b949e" stroke-width="3" stroke-dasharray="80" stroke-dashoffset="60" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 18 18" to="360 18 18" dur="1s" repeatCount="indefinite"/></circle></svg></div>` });
      }
    }
    flush();

    function flush() {
      if (!textBuf.length) return;
      const joined = textBuf.join('\n');
      textBuf = [];
      items.push({ type: 'text', html: renderAssistantText(joined) });
    }
    return items;
  }

  function normalizeCodexItems(items, options = {}) {
    if (!options.realtimeOrder) return items;
    return items.map((item, index) => ({
      item,
      index,
      order: Number.isFinite(item.displayOrder)
        ? item.displayOrder
        : index,
      blockIndex: Number.isFinite(item.blockIndex) ? item.blockIndex : 0,
    })).sort((left, right) => {
      if (left.order !== right.order) return left.order - right.order;
      if (left.blockIndex !== right.blockIndex) {
        return left.blockIndex - right.blockIndex;
      }
      return left.index - right.index;
    }).map(entry => entry.item);
  }

  function itemToHtml(item, timestamp, collapseToolDetails = false) {
    let cls = 'tl-item';
    if (item.type === 'tool') {
      cls += ' tool-node';
      if (item.toolDetails && collapseToolDetails) cls += ' tool-details-collapsed';
      if (item.codexExplore) cls += ' codex-explore';
      if (item.codexRan) cls += ' codex-ran';
      if (item.codexCalled) cls += ' codex-called';
      if (item.claudeBash) cls += ' claude-bash';
      if (item.codexWait) cls += ' codex-terminal-wait';
      if (item.codexBackgroundComplete) cls += ' codex-background-complete';
      if (item.state) cls += ' ' + item.state;
    }
    if (item.type === 'text') cls += ' assistant-text';
    if (item.type === 'thinking') cls += ' thinking-tl';
    if (item.type === 'interrupt') cls += ' msg-interrupt';
    if (item.type === 'summary') cls += ' summary-tl';
    if (item.type === 'panel') cls += ' command-panel-tl';
    const toolAttr = item.toolId ? ` data-tool-id="${escapeAttribute(item.toolId)}"` : '';
    const messageAttr = item.messageId ? ` data-message-id="${escapeAttribute(item.messageId)}"` : '';
    const nativeAttr = item.nativeId ? ` data-native-id="${escapeAttribute(item.nativeId)}"` : '';
    const processAttr = item.codexProcessId ? ` data-codex-process="${escapeAttribute(item.codexProcessId)}"` : '';
    const planAttr = item.codexPlan ? ' data-codex-plan="1"' : '';
    const tsAttr = timestamp ? ` data-ts="${escapeAttribute(timestamp)}"` : '';
    return `<div class="${cls}"${toolAttr}${messageAttr}${nativeAttr}${processAttr}${planAttr}${tsAttr}>${item.html}</div>`;
  }

  // Main: render all messages, merging consecutive assistant messages into one timeline
  window.renderMessages = function (messages, runtime, options = {}) {
    const resultMap = buildToolMaps(messages);
    const detailPolicy = window.getToolDetailPolicy?.(runtime) || {};
    const collapseToolDetails = options.collapseToolDetails !== undefined
      ? !!options.collapseToolDetails
      : !!detailPolicy.historyCollapsed;
    const html = [];
    let turnItems = []; // accumulate tl-items for current assistant turn

    function flushTurn() {
      if (!turnItems.length) return;
      const normalizedItems = runtime === 'codex'
        ? normalizeCodexItems(turnItems, options)
        : turnItems;
      const items = normalizedItems
        .filter(item => item.type !== 'interrupt')
        .concat(normalizedItems.filter(item => item.type === 'interrupt'));
      const turnId = items[0]?.turnId || '';
      const turnAttr = turnId && items.every(item => item.turnId === turnId)
        ? ` data-turn-id="${escapeAttribute(turnId)}"`
        : '';
      html.push(`<div class="assistant-turn"${turnAttr}>${items.map(i =>
        itemToHtml(i, i.ts, collapseToolDetails)).join('')}</div>`);
      turnItems = [];
    }

    for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
      const msg = messages[messageIndex];
      if (isToolResultOnly(msg)) continue;
      if (window.isSubagentNotificationMsg?.(msg)) continue;

      if (isInterruptMsg(msg)) {
        turnItems.push({
          type: 'interrupt',
          html: renderInterrupt(msg),
          messageId: msg.uuid || '',
          nativeId: msg.nativeId || '',
          turnId: msg.turnId || '',
          ts: msg.timestamp,
        });
        continue;
      }

      // Local command stdout (e.g. /compact result) → render as command output
      if (window.isLocalCommandStdout && window.isLocalCommandStdout(msg)) {
        flushTurn();
        html.push(renderLocalCommandStdout(msg));
        continue;
      }

      // User text message → flush current turn, render as bubble
      if (msg.type === 'user') {
        flushTurn();
        html.push(renderUserBubble(
          msg,
          window.isInheritedAgentContext?.(msg, messages) ? 'agent-context' : '',
        ));
        continue;
      }

      // Assistant → extract items into current turn
      if (msg.type === 'assistant') {
        if (msg._strictManaged) continue;
        const items = extractItems(msg, resultMap, runtime, {
          collapseToolDetails,
          messageIndex,
        });
        turnItems.push(...items.map((i, itemIndex) => ({
          ...i,
          messageId: msg.uuid || '',
          nativeId: msg.nativeId || '',
          turnId: msg.turnId || '',
          displayOrder: Number.isFinite(i.displayOrder)
            ? i.displayOrder
            : messageIndex,
          blockIndex: Number.isFinite(i.blockIndex)
            ? i.blockIndex
            : itemIndex,
          ts: i.ts || msg.timestamp,
        })));
        continue;
      }

      if (msg.type === 'system_event') {
        flushTurn();
        html.push(renderSystemEvent(msg));
        continue;
      }

      // Summary stays in the timeline and is collapsed by default.
      if (msg.type === 'summary') {
        const summary = renderSummary(msg);
        if (summary) {
          turnItems.push({
            type: 'summary',
            html: summary,
            turnId: msg.turnId || '',
            ts: msg.timestamp,
          });
        }
        continue;
      }
      // Metadata types: skip rendering (used for title only)
      if (msg.type === 'ai-title' || msg.type === 'custom-title' || msg.type === 'last-prompt') continue;
    }
    flushTurn();

    return html.filter(Boolean).join('');
  };

  // Render a single message into tl-item HTML fragments (for incremental append)
  window.renderSingleMessage = function (msg, allMessages, runtime) {
    if (isToolResultOnly(msg)) return '';
    if (isInterruptMsg(msg)) {
      return itemToHtml({
        type: 'interrupt',
        html: renderInterrupt(msg),
        messageId: msg.uuid || '',
        nativeId: msg.nativeId || '',
      }, msg.timestamp);
    }
    if (msg.type === 'system_event') return renderSystemEvent(msg);
    if (msg.type === 'summary') {
      return itemToHtml({ type: 'summary', html: renderSummary(msg) }, msg.timestamp);
    }
    if (msg.type !== 'assistant') return '';
    const resultMap = buildToolMaps(allMessages);
    const detailPolicy = window.getToolDetailPolicy?.(runtime) || {};
    const items = extractItems(msg, resultMap, runtime, {
      collapseToolDetails: !!detailPolicy.realtimeCollapsed,
    });
    return items.map(function (i) {
      return itemToHtml({
        ...i,
        messageId: msg.uuid || '',
        nativeId: msg.nativeId || '',
      }, i.ts || msg.timestamp, !!detailPolicy.realtimeCollapsed);
    }).join('');
  };

})();
