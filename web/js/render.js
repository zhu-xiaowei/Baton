// Message rendering orchestrator
(function () {

  function buildToolMaps(messages) {
    const resultMap = {};
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue;
      for (const b of msg.content) {
        if (b.type === 'tool_result' && b.tool_use_id) {
          // Attach Agent metadata if present on the message
          if (msg.toolUseResult) b._agentMeta = msg.toolUseResult;
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
        flush();
        window._lastToolState = '';
        const html = renderToolNode(block, resultMap[block.id] || null, runtime);
        items.push({ type: 'tool', state: window._lastToolState || '', html, toolId: block.id });
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

  function itemToHtml(item, timestamp) {
    let cls = 'tl-item';
    if (item.type === 'tool') cls += ' tool-node' + (item.state ? ' ' + item.state : '');
    if (item.type === 'text') cls += ' assistant-text';
    if (item.type === 'thinking') cls += ' thinking-tl';
    if (item.type === 'interrupt') cls += ' msg-interrupt';
    if (item.type === 'summary') cls += ' summary-tl';
    const toolAttr = item.toolId ? ` data-tool-id="${item.toolId}"` : '';
    const tsAttr = timestamp ? ` data-ts="${timestamp}"` : '';
    return `<div class="${cls}"${toolAttr}${tsAttr}>${item.html}</div>`;
  }

  // Main: render all messages, merging consecutive assistant messages into one timeline
  window.renderMessages = function (messages, runtime) {
    const resultMap = buildToolMaps(messages);
    const html = [];
    let turnItems = []; // accumulate tl-items for current assistant turn

    function flushTurn() {
      if (!turnItems.length) return;
      html.push(`<div class="assistant-turn">${turnItems.map(i => itemToHtml(i, i.ts)).join('')}</div>`);
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
        turnItems.push(...items.map(i => ({ ...i, ts: msg.timestamp })));
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
    return items.map(function (i) { return itemToHtml(i, msg.timestamp); }).join('');
  };

})();
