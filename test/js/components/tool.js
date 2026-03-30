// Tool rendering: Bash, Read, Edit, Write, Grep, Glob, etc.
(function () {
  function esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Render Bash tool
  function renderBash(input, result) {
    const cmd = input.command || input.cmd || JSON.stringify(input);
    const desc = input.description || '';
    return {
      name: 'Bash',
      desc: desc || truncate(cmd, 60),
      body: grid([
        ['IN', `<code>${esc(cmd)}</code>`],
        result != null ? ['OUT', esc(truncate(resultText(result), 2000))] : null,
      ]),
    };
  }

  // Render Read tool
  function renderRead(input, result) {
    const file = shortPath(input.file_path || '');
    let desc = file;
    if (input.offset || input.limit) {
      const from = (input.offset || 1);
      const to = input.limit ? from + input.limit - 1 : '';
      desc += ` (lines ${from}${to ? '-' + to : ''})`;
    }
    return {
      name: 'Read',
      desc,
      body: result != null ? `<div class="tool-value clamp" onclick="toggleClamp(this)">${esc(truncate(resultText(result), 2000))}</div>` : '',
    };
  }

  // File extension → hljs language
  function detectLang(path) {
    const ext = (path.split('.').pop() || '').toLowerCase();
    const map = { js:'javascript', mjs:'javascript', jsx:'javascript', ts:'typescript', tsx:'typescript',
      py:'python', rb:'ruby', css:'css', html:'html', json:'json', sh:'bash', yml:'yaml', yaml:'yaml',
      go:'go', rs:'rust', java:'java', swift:'swift', kt:'kotlin', c:'c', cpp:'cpp', md:'markdown' };
    return map[ext] || null;
  }

  // Render Edit tool with Diff2HtmlUI
  function renderEdit(input, result) {
    const file = shortPath(input.file_path || '');
    const fullPath = input.file_path || file;
    const oldStr = input.old_string || '';
    const newStr = input.new_string || '';

    let diffHtml = '';
    if (oldStr || newStr) {
      const diffId = 'diff-' + Math.random().toString(36).slice(2, 8);
      diffHtml = `<div id="${diffId}" class="diff-container"></div>`;

      setTimeout(() => {
        const el = document.getElementById(diffId);
        if (!el || typeof Diff === 'undefined' || typeof Diff2HtmlUI === 'undefined') return;
        try {
          const patch = Diff.createTwoFilesPatch(file, file, oldStr, newStr, '', '', { context: 3 });
          const ui = new Diff2HtmlUI(el, patch, {
            drawFileList: false, fileListToggle: false, fileContentToggle: false,
            stickyFileHeaders: false, outputFormat: 'line-by-line',
            matching: 'lines', colorScheme: 'dark', highlight: true,
          });
          ui.draw();
          // Set language on code blocks so hljs knows what to highlight
          const lang = detectLang(fullPath);
          if (lang) {
            // Try multiple selectors - diff2html may use different elements
            el.querySelectorAll('.d2h-code-line-ctn').forEach(ctn => {
              ctn.classList.add('language-' + lang, lang);
            });
            el.querySelectorAll('.d2h-file-wrapper').forEach(w => {
              w.dataset.lang = lang;
            });
            el.querySelectorAll('code').forEach(c => {
              c.classList.add('language-' + lang, lang);
            });
          }
          ui.highlightCode();
          // Fallback: if highlightCode didn't work, manually highlight lines without del/ins
          if (el.querySelectorAll('[class*="hljs-"]').length === 0 && lang && typeof hljs !== 'undefined') {
            el.querySelectorAll('.d2h-code-line-ctn').forEach(ctn => {
              if (!ctn.textContent.trim() || ctn.querySelector('del') || ctn.querySelector('ins')) return;
              try { ctn.innerHTML = hljs.highlight(ctn.textContent, { language: lang, ignoreIllegals: true }).value; } catch {}
            });
          }
        } catch (e) {
          el.innerHTML = '<pre style="color:#e6edf3;padding:8px;font-size:12px">'
            + (oldStr ? oldStr.split('\n').map(l => '<span style="color:#f85149">- ' + esc(l) + '</span>').join('\n') : '')
            + (oldStr && newStr ? '\n' : '')
            + (newStr ? newStr.split('\n').map(l => '<span style="color:#3fb950">+ ' + esc(l) + '</span>').join('\n') : '')
            + '</pre>';
        }
      }, 50);
    }

    const status = resultText(result);
    const statusLabel = status.includes('successfully') ? 'Modified' : (status.includes('Created') ? 'Created' : '');
    return { name: 'Edit', desc: file, status: statusLabel, body: diffHtml };
  }

  // Render Write tool
  function renderWrite(input, result) {
    const file = shortPath(input.file_path || '');
    return {
      name: 'Write',
      desc: file,
      body: result != null ? `<div class="tool-value clamp" onclick="toggleClamp(this)">${esc(truncate(resultText(result), 500))}</div>` : '',
    };
  }

  // Render Grep/Glob tool
  function renderSearch(name, input, result) {
    const pattern = input.pattern || '';
    const path = input.path ? shortPath(input.path) : '';
    const desc = pattern + (path ? ` in ${path}` : '');
    return {
      name,
      desc,
      body: result != null ? `<div class="tool-value clamp" onclick="toggleClamp(this)">${esc(truncate(resultText(result), 2000))}</div>` : '',
    };
  }

  // Render TodoWrite as checklist
  function renderTodo(input, result) {
    const todos = input.todos || [];
    if (!todos.length) return { name: 'Update Todos', desc: '', body: '' };
    const icons = { completed: '&#10003;', in_progress: '&#42;', pending: '&#9711;' };
    const colors = { completed: '#8b949e', in_progress: '#e6edf3', pending: '#8b949e' };
    const textDeco = { completed: 'line-through', in_progress: 'none', pending: 'none' };
    const html = todos.map(t => {
      const s = t.status || 'pending';
      return `<div style="display:flex;align-items:flex-start;gap:8px;padding:3px 8px;">
        <span style="color:${colors[s]};font-size:13px;flex-shrink:0;width:16px;text-align:center">${icons[s]}</span>
        <span style="color:${colors[s]};text-decoration:${textDeco[s]};font-size:12px;line-height:1.5">${esc(t.content)}</span>
      </div>`;
    }).join('');
    return { name: 'Update Todos', desc: '', body: `<div style="padding:4px 0">${html}</div>` };
  }

  // Generic fallback
  function renderGeneric(name, input, result) {
    return {
      name,
      desc: truncate(JSON.stringify(input), 80),
      body: grid([
        ['IN', esc(truncate(JSON.stringify(input, null, 2), 1000))],
        result != null ? ['OUT', esc(truncate(resultText(result), 2000))] : null,
      ]),
    };
  }

  // Build tool grid HTML
  function grid(rows) {
    const valid = rows.filter(Boolean);
    if (!valid.length) return '';
    return `<div class="tool-grid">${valid.map(([label, content]) =>
      `<div class="tool-row"><div class="tool-label">${esc(label)}</div><div class="tool-value">${content}</div></div>`
    ).join('')}</div>`;
  }

  // Extract text from tool_result content
  function resultText(result) {
    if (!result) return '';
    const c = result.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(b => b.text || '').join('');
    return JSON.stringify(c);
  }

  function shortPath(p) {
    // Show last 2-3 segments
    const parts = p.split('/');
    return parts.length > 3 ? '.../' + parts.slice(-3).join('/') : p;
  }

  function truncate(s, max) {
    if (!s) return '';
    return s.length > max ? s.slice(0, max) + '...' : s;
  }

  // Determine error state from result
  function toolState(result) {
    if (!result) return '';
    const t = resultText(result).toLowerCase();
    if (result.is_error) return 'error';
    if (t.includes('error') || t.includes('failed') || t.includes('permission denied')) return 'error';
    return '';
  }

  // Main: render a tool_use + tool_result pair (wrapping tl-item div is in render.js)
  window.renderToolNode = function (toolUse, toolResult) {
    const name = toolUse.name || 'Tool';
    const input = toolUse.input || {};
    const dispatchers = {
      Bash: () => renderBash(input, toolResult),
      Read: () => renderRead(input, toolResult),
      Edit: () => renderEdit(input, toolResult),
      Write: () => renderWrite(input, toolResult),
      Grep: () => renderSearch('Grep', input, toolResult),
      Glob: () => renderSearch('Glob', input, toolResult),
      TodoWrite: () => renderTodo(input, toolResult),
    };
    const info = (dispatchers[name] || (() => renderGeneric(name, input, toolResult)))();
    // Store state as data attr for CSS (render.js adds .error/.warning to tl-item)
    window._lastToolState = toolState(toolResult);

    const statusHtml = info.status ? `<span class="tool-status">${esc(info.status)}</span>` : '';
    const id = 'tool-' + Math.random().toString(36).slice(2, 8);

    const noClamp = name === 'TodoWrite';
    const clampClass = noClamp ? ' no-clamp' : '';
    const bodyHtml = info.body
      ? `<div class="tool-body">
          <div class="tool-body-content${clampClass}" id="${id}" ${noClamp ? '' : `onclick="toggleToolBody('${id}')"`}>${info.body}</div>
        </div>`
      : '';

    return `<div class="tool-header">
        <span class="tool-name">${esc(info.name)}</span>
        <span class="tool-desc">${esc(info.desc)}</span>
        ${statusHtml}
      </div>
      ${bodyHtml}`;
  };

  window.toggleToolBody = function (id) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('open');
  };

  // Toggle clamp on tool-value elements
  window.toggleClamp = function (el) {
    el.classList.toggle('expanded');
  };
})();
