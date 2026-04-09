// Message bubble components
(function () {
  function esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function fmtTime(ts) {
    return ts ? new Date(ts).toLocaleTimeString() : '';
  }

  // Interrupt text mapping (same as Claude Code)
  const INTERRUPT_MAP = {
    '[Request interrupted by user]': 'Interrupted',
    '[Request interrupted by user for tool use]': 'Tool interrupted',
  };

  // Check if a message is an interrupt
  window.isInterruptMsg = function (msg) {
    if (msg.type !== 'user' || !Array.isArray(msg.content)) return false;
    const text = msg.content.length === 1 && msg.content[0].type === 'text' ? msg.content[0].text : '';
    return !!INTERRUPT_MAP[text];
  };

  // Check if a message is tool_result only (should be consumed by tool nodes)
  window.isToolResultOnly = function (msg) {
    if (msg.type !== 'user' || !Array.isArray(msg.content)) return false;
    return msg.content.every(b => b.type === 'tool_result');
  };

  // Detect if filename is a code file
  function isCodeFile(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    return ['js','mjs','jsx','ts','tsx','py','rb','css','html','json','sh','yml','yaml',
      'go','rs','java','swift','kt','c','cpp','h','hpp','cs','php','sql','xml','toml','md'].includes(ext);
  }

  // Render a file badge
  function fileBadge(title, content) {
    const id = 'doc-' + Math.random().toString(36).slice(2, 8);
    const icon = isCodeFile(title) ? '&lt;/&gt;' : '&#128196;';
    const iconClass = isCodeFile(title) ? 'file-badge-icon code' : 'file-badge-icon doc';
    return `<div class="file-badge" onclick="var b=document.getElementById('${id}');b.style.display=b.style.display==='block'?'none':'block'">
      <span class="${iconClass}">${icon}</span><span class="file-badge-name">${esc(title)}</span>
    </div><pre class="file-badge-content" id="${id}">${esc(content)}</pre>`;
  }

  // Render user text bubble
  window.renderUserBubble = function (msg) {
    let text = '';
    if (typeof msg.content === 'string') text = msg.content;
    else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter(b => b.type === 'text')
        .map(b => b.text || '')
        .join('\n');
    }

    // Extract slash command from CC XML tags before stripping
    let slashCmd = '';
    text = text.replace(/<command-name>\/?(\w+)<\/command-name>/g, (_, cmd) => { slashCmd = cmd; return ''; });
    text = text.replace(/<command-message>.*?<\/command-message>\s*/gs, '');
    text = text.replace(/<command-args>.*?<\/command-args>\s*/gs, '');
    text = text.replace(/<local-command-caveat>.*?<\/local-command-caveat>\s*/gs, '');
    text = text.replace(/<ide_selection>.*?<\/ide_selection>\s*/gs, '');
    text = text.replace(/<system-reminder>.*?<\/system-reminder>\s*/gs, '');

    // Also catch plain /command at start
    if (!slashCmd) text = text.replace(/^\/(\w+)\s*/m, (_, cmd) => { slashCmd = cmd; return ''; });

    // Extract <ide_opened_file> references from text
    const ideFiles = [];
    text = text.replace(/<ide_opened_file>.*?opened the file (.*?) in the IDE.*?<\/ide_opened_file>\n?/g, (_, path) => {
      ideFiles.push(path);
      return '';
    });

    // Collect document blocks
    const docs = Array.isArray(msg.content)
      ? msg.content.filter(b => b.type === 'document' && b.title)
      : [];

    // Collect images from content blocks
    const images = Array.isArray(msg.content)
      ? msg.content.filter(b => b.type === 'image' && b.key)
      : [];

    // Parse ![](path) markdown image refs in text (from claude-bridge image sends)
    const mdImages = [];
    text = text.replace(/!\[.*?\]\(([^)]+)\)\n?/g, (_, imgPath) => {
      mdImages.push(imgPath);
      return '';
    });

    // Build attachments row (file badges + images)
    const badges = [];
    ideFiles.forEach(p => {
      const name = p.split('/').pop();
      badges.push(fileBadge(name, p));
    });
    docs.forEach(d => {
      const content = d.source?.data || '';
      badges.push(fileBadge(d.title, content));
    });
    images.forEach(b => {
      badges.push(`<div class="img-placeholder" data-key="${esc(b.key)}">loading</div>`);
    });
    mdImages.forEach(imgPath => {
      // Extract image key: from "claude-bridge:key" or filename from absolute path
      const cbMatch = imgPath.match(/claude-bridge:(.+)/);
      const key = cbMatch ? cbMatch[1] : imgPath.split('/').pop();
      if (key && key.match(/\.(jpg|png|jpeg)$/i)) {
        badges.push(`<div class="img-placeholder" data-key="${esc(key)}">loading</div>`);
      }
    });
    const attachHtml = badges.length ? `<div class="msg-attachments">${badges.join('')}</div>` : '';

    const displayText = slashCmd ? `/${slashCmd}${text.trim() ? ' ' + text.trim() : ''}` : text.trim();

    if (!displayText && !attachHtml) return '';
    return `<div class="msg-user">
      ${attachHtml}
      ${displayText ? `<div class="msg-text${displayText.split('\n').length > 3 || displayText.length > 300 ? ' clamped' : ''}" onclick="this.classList.toggle('clamped');this.classList.toggle('expanded')">${esc(displayText)}</div>` : ''}
      <div class="msg-time">${fmtTime(msg.timestamp)}</div>
    </div>`;
  };

  // Render interrupt indicator (returns inner content, wrapping tl-item is in render.js)
  window.renderInterrupt = function (msg) {
    const text = msg.content[0].text;
    return INTERRUPT_MAP[text] || 'Interrupted';
  };

  // Render thinking block (collapsible)
  window.renderThinking = function (block) {
    const secs = Math.round((block.duration_ms || 0) / 1000);
    const label = secs > 0 ? `Thought for ${secs}s` : 'Thinking';
    const id = 'think-' + Math.random().toString(36).slice(2, 8);
    return `<div class="thinking-block">
      <div class="thinking-toggle" onclick="var b=document.getElementById('${id}');b.style.display=b.style.display==='block'?'none':'block'">${label} &#8250;</div>
      <div class="thinking-body" id="${id}">${esc(block.thinking || '')}</div>
    </div>`;
  };

  // Render system / summary / ai-title
  window.renderSystemMsg = function (msg) {
    const content = typeof msg.content === 'string' ? msg.content
      : Array.isArray(msg.content) ? msg.content.map(b => b.text || '').join('')
      : JSON.stringify(msg.content);
    if (msg.type === 'ai-title') {
      return `<div class="msg-ai-title">${esc(content)}</div>`;
    }
    return `<div class="msg-system">${esc(content)}</div>`;
  };
})();
