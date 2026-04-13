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
  function extractItems(msg, resultMap) {
    const items = [];
    if (!Array.isArray(msg.content)) {
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (text) items.push({ type: 'text', html: renderMd(text) });
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
        const html = renderToolNode(block, resultMap[block.id] || null);
        items.push({ type: 'tool', state: window._lastToolState || '', html, toolId: block.id });
      } else if (block.type === 'image' && block.key) {
        textBuf.push(`<div class="img-placeholder" data-key="${block.key}">loading</div>`);
      }
    }
    flush();

    function flush() {
      if (!textBuf.length) return;
      const joined = textBuf.join('\n');
      textBuf = [];
      items.push({ type: 'text', html: joined.includes('img-placeholder') ? joined : renderMd(joined) });
    }
    return items;
  }

  function itemToHtml(item) {
    let cls = 'tl-item';
    if (item.type === 'tool') cls += ' tool-node' + (item.state ? ' ' + item.state : '');
    if (item.type === 'text') cls += ' assistant-text';
    if (item.type === 'thinking') cls += ' thinking-tl';
    if (item.type === 'interrupt') cls += ' msg-interrupt';
    const toolAttr = item.toolId ? ` data-tool-id="${item.toolId}"` : '';
    return `<div class="${cls}"${toolAttr}>${item.html}</div>`;
  }

  // Main: render all messages, merging consecutive assistant messages into one timeline
  window.renderMessages = function (messages) {
    const resultMap = buildToolMaps(messages);
    const html = [];
    let turnItems = []; // accumulate tl-items for current assistant turn

    function flushTurn() {
      if (!turnItems.length) return;
      html.push(`<div class="assistant-turn">${turnItems.map(itemToHtml).join('')}</div>`);
      turnItems = [];
    }

    for (const msg of messages) {
      if (isToolResultOnly(msg)) continue;

      if (isInterruptMsg(msg)) {
        turnItems.push({ type: 'interrupt', html: renderInterrupt(msg) });
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
        const items = extractItems(msg, resultMap);
        turnItems.push(...items);
        continue;
      }

      // Summary/ai-title → flush turn, render standalone
      if (msg.type === 'summary' || msg.type === 'ai-title') {
        flushTurn();
        html.push(renderSystemMsg(msg));
        continue;
      }
    }
    flushTurn();

    return html.filter(Boolean).join('');
  };

  // Render a single message into tl-item HTML fragments (for incremental append)
  window.renderSingleMessage = function (msg, allMessages) {
    if (isToolResultOnly(msg)) return '';
    if (isInterruptMsg(msg)) {
      return itemToHtml({ type: 'interrupt', html: renderInterrupt(msg) });
    }
    if (msg.type !== 'assistant') return '';
    const resultMap = buildToolMaps(allMessages);
    const items = extractItems(msg, resultMap);
    return items.map(itemToHtml).join('');
  };

})();
