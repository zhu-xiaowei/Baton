// Message bubble components
(function () {
  function esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function fmtTime(ts) {
    return ts ? new Date(ts).toLocaleTimeString() : '';
  }

  function contentText(msg) {
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) return msg.content.map(b => b.text || '').join('');
    return JSON.stringify(msg.content);
  }

  const CODEX_COMPACTION_PREFIX = 'Another language model started to solve this problem and produced a summary of its thinking process. '
    + 'You also have access to the state of the tools that were used by that language model. '
    + 'Use this to build on the work that has already been done and avoid duplicating work. '
    + 'Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:';

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

  // Plain text of a user message (content is a string from the bridge, but be safe).
  function userText(msg) {
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) return msg.content.map(b => b.text || '').join('');
    return '';
  }

  // CC writes a local command's stdout back as a user message wrapped in
  // <local-command-stdout> (e.g. /compact's "Compacted" summary). It's command
  // output, not a user turn — render it like captured command output, not a bubble.
  window.isLocalCommandStdout = function (msg) {
    return msg.type === 'user' && /<local-command-stdout>/.test(userText(msg));
  };

  // User messages that aren't a real turn awaiting a reply: system noise
  // (caveat/notification/reminder) and /clear (resets context, no reply).
  // Other <command-name> reads as running (user invoked a command).
  window.isLocalCommandMarker = function (msg) {
    if (msg.type !== 'user') return false;
    var t = userText(msg);
    if (/^\s*<(?:local-command-caveat|task-notification|system-reminder)/.test(t)) return true;
    if (/^\s*<command-name>\/?clear<\/command-name>/.test(t)) return true;
    return false;
  };

  // Detect if filename is a code file
  function isCodeFile(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    return ['js','mjs','jsx','ts','tsx','py','rb','css','html','json','sh','yml','yaml',
      'go','rs','java','swift','kt','c','cpp','h','hpp','cs','php','sql','xml','toml','md'].includes(ext);
  }

  // Render a file badge. With filePath → click opens the source file; otherwise → toggle inline content.
  function fileBadge(title, content, filePath) {
    const icon = isCodeFile(title) ? '&lt;/&gt;' : '&#128196;';
    const iconClass = isCodeFile(title) ? 'file-badge-icon code' : 'file-badge-icon doc';
    const badge = (onclick) => `<div class="file-badge" onclick="${onclick}">
      <span class="${iconClass}">${icon}</span><span class="file-badge-name">${esc(title)}</span>
    </div>`;
    if (filePath) {
      const safe = filePath.replace(/'/g, "\\'");
      return badge(`openFile('${safe}','${esc(title).replace(/'/g, "\\'")}')`);
    }
    const id = 'doc-' + Math.random().toString(36).slice(2, 8);
    return badge(`var b=document.getElementById('${id}');b.style.display=b.style.display==='block'?'none':'block'`)
      + `<pre class="file-badge-content" id="${id}">${esc(content)}</pre>`;
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
    // Command names can include a plugin namespace + hyphens, e.g.
    // "document-skills:pdf" — match [\w:-]+, not just \w+.
    text = text.replace(/<command-name>\/?([\w:-]+)<\/command-name>/g, (_, cmd) => { slashCmd = cmd; return ''; });
    text = text.replace(/<command-message>.*?<\/command-message>\s*/gs, '');
    text = text.replace(/<command-args>.*?<\/command-args>\s*/gs, '');
    text = text.replace(/<local-command-caveat>.*?<\/local-command-caveat>\s*/gs, '');
    text = text.replace(/<ide_selection>.*?<\/ide_selection>\s*/gs, '');
    text = text.replace(/<system-reminder>.*?<\/system-reminder>\s*/gs, '');
    text = text.replace(/<task-notification>.*?<\/task-notification>\s*/gs, '');

    // Also catch plain /command at start (optimistic render before CC rewrites it)
    if (!slashCmd) text = text.replace(/^\/([\w:-]+)\s*/m, (_, cmd) => { slashCmd = cmd; return ''; });

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

    // Parse ![](path) markdown image refs in text (from baton-bridge image sends)
    const mdImages = [];
    text = text.replace(/!\[.*?\]\(([^)]+)\)\n?/g, (_, imgPath) => {
      mdImages.push(imgPath);
      return '';
    });

    // Build attachments row (file badges + images)
    const badges = [];
    ideFiles.forEach(p => {
      const name = p.split('/').pop();
      badges.push(fileBadge(name, p, p));
    });
    docs.forEach(d => {
      const content = d.source?.data || '';
      badges.push(fileBadge(d.title, content));
    });
    images.forEach(b => {
      badges.push(`<div class="img-placeholder" data-key="${esc(b.key)}"><svg class="img-spinner" viewBox="0 0 36 36"><circle cx="18" cy="18" r="14" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="3"/><circle cx="18" cy="18" r="14" fill="none" stroke="#8b949e" stroke-width="3" stroke-dasharray="80" stroke-dashoffset="60" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 18 18" to="360 18 18" dur="1s" repeatCount="indefinite"/></circle></svg></div>`);
    });
    mdImages.forEach(imgPath => {
      // Extract image key: from "baton-bridge:key" or filename from absolute path
      const cbMatch = imgPath.match(/baton-bridge:(.+)/);
      const key = cbMatch ? cbMatch[1] : imgPath.split('/').pop();
      if (key && key.match(/\.(jpg|png|jpeg)$/i)) {
        badges.push(`<div class="img-placeholder" data-key="${esc(key)}"><svg class="img-spinner" viewBox="0 0 36 36"><circle cx="18" cy="18" r="14" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="3"/><circle cx="18" cy="18" r="14" fill="none" stroke="#8b949e" stroke-width="3" stroke-dasharray="80" stroke-dashoffset="60" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 18 18" to="360 18 18" dur="1s" repeatCount="indefinite"/></circle></svg></div>`);
      }
    });
    const attachHtml = badges.length ? `<div class="msg-attachments">${badges.join('')}</div>` : '';

    const displayText = slashCmd ? `/${slashCmd}${text.trim() ? ' ' + text.trim() : ''}` : text.trim();

    if (!displayText && !attachHtml) return '';
    return `<div class="msg-user"${msg.timestamp ? ` data-ts="${esc(msg.timestamp)}"` : ''}>
      ${attachHtml}
      ${displayText ? `<div class="msg-text" onclick="toggleExpand(this)">${esc(displayText)}</div>` : ''}
      <div class="msg-meta"><span class="msg-time">${fmtTime(msg.timestamp)}</span></div>
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
      <div class="thinking-toggle" onclick="this.classList.toggle('open');var b=document.getElementById('${id}');b.style.display=b.style.display==='block'?'none':'block'">${label} <span class="thinking-chevron">&#8250;</span></div>
      <div class="thinking-body" id="${id}">${esc(block.thinking || '')}</div>
    </div>`;
  };

  window.renderSystemEvent = function (msg) {
    const content = contentText(msg);
    if (!content) return '';
    return `<div class="msg-system-event"${msg.timestamp ? ` data-ts="${esc(msg.timestamp)}"` : ''}><span>${esc(content)}</span></div>`;
  };

  window.renderSummary = function (msg) {
    let content = contentText(msg).trim();
    if (content.startsWith(CODEX_COMPACTION_PREFIX)) {
      content = content.slice(CODEX_COMPACTION_PREFIX.length).trim();
    }
    if (!content) return '';
    return `<details class="summary-block">
      <summary><span>Context compacted</span><span class="summary-chevron">&#8250;</span></summary>
      <div class="summary-body assistant-text">${renderAssistantText(content)}</div>
    </details>`;
  };

  // Render system / ai-title
  window.renderSystemMsg = function (msg) {
    const content = contentText(msg);
    if (msg.type === 'ai-title') {
      return `<div class="msg-ai-title">${esc(content)}</div>`;
    }
    return `<div class="msg-system">${esc(content)}</div>`;
  };
  // Render a <local-command-stdout> user message (e.g. /compact result) as command
  // output: strip the wrapper tags + ANSI escape codes, show as a clean cmd-output.
  window.renderLocalCommandStdout = function (msg) {
    var text = userText(msg)
      .replace(/<\/?local-command-stdout>/g, '')
      .replace(/\x1b\[[0-9;]*m/g, '') // strip ANSI colour codes
      .replace(/\[\d+m/g, '')         // strip bare [2m/[22m the terminal echoed
      .trim();
    if (!text) return '';
    return `<div class="cmd-output"${msg.timestamp ? ` data-ts="${esc(msg.timestamp)}"` : ''}><pre>${esc(text)}</pre></div>`;
  };

  var BTN = '<span class="clamp-btn" onclick="event.stopPropagation();toggleExpand(this.parentElement)">Show more</span>';
  var BTN_MSG = '<span class="clamp-btn" onclick="event.stopPropagation();toggleExpand(this.closest(\'.msg-user\').querySelector(\'.msg-text\'))">Show more</span>';

  window.toggleExpand = function (el) {
    var sel = window.getSelection();
    if (sel && sel.toString().length > 0) return;
    if (el.classList.contains('msg-text')) {
      el.classList.toggle('clamped');
      el.classList.toggle('expanded');
    } else if (el.classList.contains('tool-body-content')) {
      el.classList.toggle('open');
    } else if (el.classList.contains('tool-value')) {
      el.classList.toggle('expanded');
    }
    var btn = el.classList.contains('msg-text')
      ? (el.closest('.msg-user') || {}).querySelector && el.closest('.msg-user').querySelector('.msg-meta .clamp-btn')
      : el.querySelector('.clamp-btn');
    if (btn) btn.textContent = (el.classList.contains('expanded') || el.classList.contains('open')) ? 'Show less' : 'Show more';
  };

  window.clampOverflow = function (container) {
    if (!container) return;
    container.querySelectorAll('.msg-text:not(.clamped):not(.expanded)').forEach(function (el) {
      if (el.scrollHeight > 60) {
        el.classList.add('clamped');
        var meta = el.parentElement.querySelector('.msg-meta');
        if (meta && !meta.querySelector('.clamp-btn')) meta.insertAdjacentHTML('beforeend', BTN_MSG);
      }
    });
    container.querySelectorAll('.tool-value.clamp:not(.expanded)').forEach(function (el) {
      if (el.scrollHeight > el.clientHeight + 2 && !el.querySelector('.clamp-btn')) el.insertAdjacentHTML('beforeend', BTN);
    });
    container.querySelectorAll('.tool-body-content.collapsible:not(.open)').forEach(function (el) {
      if (!el.querySelector('.clamp-btn')) el.insertAdjacentHTML('beforeend', BTN);
    });
    container.querySelectorAll('.tool-body-content:not(.collapsible) .diff-container').forEach(function (diff) {
      if (diff.scrollHeight <= 240) return;
      var body = diff.closest('.tool-body-content');
      if (!body) return;
      body.classList.add('collapsible');
      if (!body.querySelector('.clamp-btn')) body.insertAdjacentHTML('beforeend', BTN);
    });
    // Tool body with clamped .tool-value children (Bash IN/OUT, etc.)
    container.querySelectorAll('.tool-body-content:not(.open):not(.no-clamp):not(.collapsible)').forEach(function (el) {
      if (el.querySelector('.clamp-btn')) return;
      var hasOverflow = false;
      el.querySelectorAll('.tool-value').forEach(function (v) {
        if (v.scrollHeight > v.clientHeight + 2) hasOverflow = true;
      });
      if (hasOverflow) el.insertAdjacentHTML('beforeend', BTN);
    });
  };
})();
