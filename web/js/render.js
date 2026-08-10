// Message rendering orchestrator
(function () {

  window.markCodexExploreGroups = function (container) {
    if (!container) return;
    let run = [];
    const flushWaitRun = () => {
      if (!run.length) return;
      const items = run.flatMap((row) => Array.from(row.children));
      let pendingWait = null;
      for (const item of items) {
        if (item.classList?.contains('codex-terminal-wait')) {
          const processId = item.dataset?.codexProcess || '';
          if (pendingWait && pendingWait.processId === processId) {
            item.remove();
            continue;
          }
          if (pendingWait) item.before(pendingWait.node);
          pendingWait = { node: item, processId };
          continue;
        }
        if (pendingWait && (
          item.classList?.contains('assistant-text')
          || (item.classList?.contains('codex-background-complete')
            && item.dataset?.codexProcess === pendingWait.processId)
        )) {
          item.before(pendingWait.node);
          pendingWait = null;
        }
      }
      if (pendingWait) run.at(-1).appendChild(pendingWait.node);
      for (const row of run) {
        if (!row.children.length) row.remove();
      }
      run = [];
    };
    for (const row of Array.from(container.children)) {
      if (row.classList?.contains('assistant-turn')) run.push(row);
      else flushWaitRun();
    }
    flushWaitRun();

    let exploreRows = [];
    const flushExploreRun = () => {
      if (!exploreRows.length) return;
      const items = exploreRows.flatMap((row) => Array.from(row.children));
      for (const item of items) {
        item.classList?.remove(
          'codex-explore-continuation',
          'codex-explore-group-start',
          'codex-explore-group-connected',
        );
      }
      for (let start = 0; start < items.length;) {
        if (!items[start].classList?.contains('codex-explore')) {
          start++;
          continue;
        }
        let end = start + 1;
        while (end < items.length && items[end].classList?.contains('codex-explore')) end++;
        if (end - start > 1) {
          items[start].classList.add('codex-explore-group-start');
          for (let index = start + 1; index < end; index++) {
            items[index].classList.add('codex-explore-continuation');
          }
          if (end < items.length) {
            for (let index = start; index < end; index++) {
              items[index].classList.add('codex-explore-group-connected');
            }
          }
        }
        start = end;
      }
      exploreRows = [];
    };
    for (const row of container.children) {
      if (row.classList?.contains('assistant-turn')) exploreRows.push(row);
      else flushExploreRun();
    }
    flushExploreRun();
  };

  function buildToolMaps(messages) {
    const resultMap = {};
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue;
      for (const b of msg.content) {
        if (b.type === 'tool_result' && b.tool_use_id) {
          if (b.codexSuperseded) continue;
          // Attach Agent metadata if present on the message
          if (msg.toolUseResult) b._agentMeta = msg.toolUseResult;
          b._timestamp = msg.timestamp || '';
          resultMap[b.tool_use_id] = b;
        }
      }
    }
    return resultMap;
  }

  // Convert one assistant message into an array of tl-item objects
  function extractItems(msg, resultMap, runtime) {
    const items = [];
    if (!Array.isArray(msg.content)) {
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (text) items.push({ type: 'text', html: renderAssistantText(text) });
      return items;
    }

    let textBuf = [];
    for (const block of msg.content) {
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
        const html = renderToolNode(block, result, runtime);
        const emptyTerminalWait = runtime === 'codex'
          && block.name === 'WriteStdin'
          && !String(block.input?.chars || '').length;
        items.push({
          type: 'tool',
          state: window._lastToolState || '',
          html,
          toolId: block.id,
          codexExplore: runtime === 'codex' && !!window.isCodexExploreTool?.(block, result),
          codexWait: emptyTerminalWait,
          codexProcessId: String(result?.codexProcessId || block.input?.session_id || ''),
          codexBackgroundComplete: result?.codexBackground === 'complete',
          codexCompleted: runtime === 'codex' && block.name === 'Bash' && !!result?._timestamp,
          ts: runtime === 'codex' && block.name === 'Bash' && result?._timestamp
            ? result._timestamp
            : undefined,
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

  function sortCodexCells(items) {
    const cells = [];
    for (let index = 0; index < items.length;) {
      const item = items[index];
      if (!item.codexExplore) {
        cells.push({ items: [item], ts: item.ts || '', _order: index });
        index++;
        continue;
      }
      const group = [];
      const start = index;
      while (index < items.length && items[index].codexExplore) {
        group.push(items[index++]);
      }
      const completed = group.every((member) => member.codexCompleted);
      const ts = completed
        ? group.reduce((latest, member) => member.ts > latest ? member.ts : latest, '')
        : (group[0].ts || '');
      cells.push({ items: group, ts, _order: start, completed });
    }
    cells.sort((a, b) => a.ts.localeCompare(b.ts) || a._order - b._order);
    return cells.flatMap((cell) => cell.items.map((item) => (
      cell.items.length > 1 ? { ...item, ts: cell.ts } : item
    )));
  }

  function normalizeCodexItems(items) {
    const sorted = sortCodexCells(items);
    const output = [];
    let pendingWait = null;
    for (const item of sorted) {
      if (item.codexWait) {
        if (pendingWait && pendingWait.codexProcessId !== item.codexProcessId) {
          output.push(pendingWait);
        }
        pendingWait = item;
        continue;
      }
      if (pendingWait && (
        item.type === 'text'
        || (item.codexBackgroundComplete
          && item.codexProcessId === pendingWait.codexProcessId)
      )) {
        output.push(pendingWait);
        pendingWait = null;
      }
      output.push(item);
    }
    if (pendingWait) output.push(pendingWait);
    return output;
  }

  function itemToHtml(item, timestamp) {
    let cls = 'tl-item';
    if (item.type === 'tool') {
      cls += ' tool-node';
      if (item.codexExplore) cls += ' codex-explore';
      if (item.codexWait) cls += ' codex-terminal-wait';
      if (item.codexBackgroundComplete) cls += ' codex-background-complete';
      if (item.state) cls += ' ' + item.state;
    }
    if (item.type === 'text') cls += ' assistant-text';
    if (item.type === 'thinking') cls += ' thinking-tl';
    if (item.type === 'interrupt') cls += ' msg-interrupt';
    if (item.type === 'summary') cls += ' summary-tl';
    const toolAttr = item.toolId ? ` data-tool-id="${item.toolId}"` : '';
    const processAttr = item.codexProcessId ? ` data-codex-process="${item.codexProcessId}"` : '';
    const tsAttr = timestamp ? ` data-ts="${timestamp}"` : '';
    return `<div class="${cls}"${toolAttr}${processAttr}${tsAttr}>${item.html}</div>`;
  }

  // Main: render all messages, merging consecutive assistant messages into one timeline
  window.renderMessages = function (messages, runtime) {
    const resultMap = buildToolMaps(messages);
    const html = [];
    let turnItems = []; // accumulate tl-items for current assistant turn

    function flushTurn() {
      if (!turnItems.length) return;
      const items = runtime === 'codex' ? normalizeCodexItems(turnItems) : turnItems;
      html.push(`<div class="assistant-turn">${items.map(i => itemToHtml(i, i.ts)).join('')}</div>`);
      turnItems = [];
    }

    for (const msg of messages) {
      if (isToolResultOnly(msg)) continue;

      if (isInterruptMsg(msg)) {
        turnItems.push({ type: 'interrupt', html: renderInterrupt(msg), ts: msg.timestamp });
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
        html.push(renderUserBubble(msg));
        continue;
      }

      // Assistant → extract items into current turn
      if (msg.type === 'assistant') {
        const items = extractItems(msg, resultMap, runtime);
        turnItems.push(...items.map(i => ({ ...i, ts: i.ts || msg.timestamp })));
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
        if (summary) turnItems.push({ type: 'summary', html: summary, ts: msg.timestamp });
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
      return itemToHtml({ type: 'interrupt', html: renderInterrupt(msg) }, msg.timestamp);
    }
    if (msg.type === 'system_event') return renderSystemEvent(msg);
    if (msg.type === 'summary') {
      return itemToHtml({ type: 'summary', html: renderSummary(msg) }, msg.timestamp);
    }
    if (msg.type !== 'assistant') return '';
    const resultMap = buildToolMaps(allMessages);
    const items = extractItems(msg, resultMap, runtime);
    return items.map(function (i) { return itemToHtml(i, i.ts || msg.timestamp); }).join('');
  };

})();
