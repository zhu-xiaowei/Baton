// Tool rendering: Bash, Read, Edit, Write, Grep, Glob, etc.
(function () {
  // On cancel, the bridge denies the ask/plan with interrupt:true; CC overwrites the tool_result with this rejection text.
  var CANCEL_MARK = 'tool use was rejected';
  const CODEX_TOOL_NAMES = {
    Read: 'Explored',
    Grep: 'Explored',
    Glob: 'Explored',
    Edit: 'Edited',
    Write: 'Edited',
    TodoWrite: 'Updated Plan',
    ViewImage: 'Viewed Image',
    ToolSearch: 'Searched Tools',
    WebSearch: 'Searched the web',
    get_goal: 'Checked Goal',
    spawn_agent: 'Spawned Agent',
    send_input: 'Sent Agent Input',
    wait_agent: 'Waited for Agent',
    close_agent: 'Closed Agent',
    request_user_input: 'Requested Input',
    Agent: 'Ran Agent',
    WriteStdin: 'Ran',
  };
  function esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ANSI escape codes in terminal output → colored HTML (XSS-safe via anser).
  // Fast path: no ESC byte or lib not loaded → plain esc().
  function ansiHtml(str) {
    if (!str) return '';
    str = String(str);
    if (str.indexOf('\x1b') === -1) return esc(str);
    if (!window.Anser) return esc(str);
    // use_classes: emit `ansi-*` class names instead of inline RGB, so our dark
    // theme controls the palette (CC's default colours/dim are invisible on #0d1117).
    return window.Anser.ansiToHtml(window.Anser.escapeForHtml(str), { use_classes: true });
  }
  window.ansiHtml = ansiHtml;

  // Render Bash tool
  function codexCommandSummary(actions) {
    if (!Array.isArray(actions) || !actions.length) return '';
    const kinds = new Set(actions.map((action) => action?.type));
    if (kinds.size !== 1) return '';
    const kind = actions[0]?.type;
    if (kind === 'read') {
      const names = actions.map((action) => action?.name || action?.path).filter(Boolean);
      return names.length ? `Read ${names.join(', ')}` : '';
    }
    if (kind === 'search') {
      const terms = actions.map((action) => action?.query || action?.path).filter(Boolean);
      return terms.length ? `Search ${terms.join(', ')}` : '';
    }
    if (kind === 'list_files') {
      const paths = actions.map((action) => action?.path).filter(Boolean);
      return paths.length ? `List ${paths.join(', ')}` : 'List files';
    }
    return '';
  }

  function renderBash(input, result) {
    const cmd = input.command || input.cmd || JSON.stringify(input);
    const actions = result?.codexCommandActions || input.codexCommandActions;
    const desc = codexCommandSummary(actions) || input.description || '';
    const elevated = input.sandbox_permissions === 'require_escalated';
    const justification = elevated ? String(input.justification || '').trim() : '';
    return {
      name: 'Bash',
      desc: desc || truncate(cmd, 60),
      elevated,
      body: (justification
        ? `<div class="tool-note"><span>Request reason</span>${esc(justification)}</div>`
        : '') + grid([
          ['IN', `<code>${esc(cmd)}</code>`],
          result != null ? ['OUT', ansiHtml(resultText(result))] : null,
        ]),
    };
  }

  // Render Read tool
  function renderRead(input, result) {
    const file = shortPath(input.file_path || '');
    let desc = file;
    let line = '';
    if (input.offset || input.limit) {
      const from = (input.offset || 1);
      const to = input.limit ? from + input.limit - 1 : '';
      desc += ` (lines ${from}${to ? '-' + to : ''})`;
      line = to ? `${from}-${to}` : String(from);
    }
    return {
      name: 'Read',
      desc,
      fileLink: input.file_path || '',
      fileLine: line,
      body: readResultBody(result),
    };
  }

  function readResultBody(result) {
    if (!result) return '';
    const c = result.content;
    if (!c) return '';
    let text = '';
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) text = c.filter(b => b.type === 'text' && b.text).map(b => b.text).join('');
    text = text.trim();
    if (!text) return '';
    return `<div class="tool-value clamp" onclick="toggleExpand(this)">${ansiHtml(text)}</div>`;
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
      // diff2html draws async (setTimeout below), so its height is 0 at scroll
      // time and the initial scroll-to-bottom lands short. Reserve an estimated
      // min-height (~18px/row, capped at the 240px collapse threshold); cleared
      // after draw, residual absorbed by the browser's overflow-anchor.
      const _oldLines = oldStr ? oldStr.split('\n').length : 0;
      const _newLines = newStr ? newStr.split('\n').length : 0;
      const _estH = Math.min((_oldLines + _newLines) * 18 + 12, 240);
      diffHtml = `<div id="${diffId}" class="diff-container" style="min-height:${_estH}px"></div>`;

      setTimeout(() => {
        const el = document.getElementById(diffId);
        if (!el || typeof Diff === 'undefined' || typeof Diff2HtmlUI === 'undefined') return;
        try {
          // Ensure trailing newlines so diff library doesn't flag unchanged lines
          const a = oldStr.endsWith('\n') ? oldStr : oldStr + '\n';
          const b = newStr.endsWith('\n') ? newStr : newStr + '\n';
          const patch = Diff.createTwoFilesPatch(file, file, a, b, '', '', { context: 3 });
          const ui = new Diff2HtmlUI(el, patch, {
            drawFileList: false, fileListToggle: false, fileContentToggle: false,
            stickyFileHeaders: false, outputFormat: 'line-by-line',
            matching: 'lines', colorScheme: 'dark', highlight: true,
          });
          ui.draw();
          // Force remove white backgrounds from structural diff2html elements only
          el.querySelectorAll('.d2h-file-wrapper, .d2h-file-diff, .d2h-code-wrapper, .d2h-diff-table, .d2h-diff-tbody').forEach(node => {
            node.style.backgroundColor = 'transparent';
          });
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
          // Ensure every line gets syntax highlighting
          if (lang && typeof hljs !== 'undefined') {
            el.querySelectorAll('.d2h-code-line-ctn').forEach(ctn => {
              if (!ctn.textContent.trim()) return;
              // Skip if already highlighted
              if (ctn.querySelector('[class*="hljs-"]')) return;
              const delIns = ctn.querySelectorAll('del, ins');
              if (delIns.length > 0) {
                // Highlight text inside each del/ins separately, preserving the tag
                delIns.forEach(tag => {
                  if (!tag.textContent.trim()) return;
                  try { tag.innerHTML = hljs.highlight(tag.textContent, { language: lang, ignoreIllegals: true }).value; } catch(e) {}
                });
              } else {
                try { ctn.innerHTML = hljs.highlight(ctn.textContent, { language: lang, ignoreIllegals: true }).value; } catch(e) {}
              }
            });
          }
        } catch (e) {
          el.innerHTML = '<pre style="color:#e6edf3;padding:8px;font-size:12px">'
            + (oldStr ? oldStr.split('\n').map(l => '<span style="color:#f85149">- ' + esc(l) + '</span>').join('\n') : '')
            + (oldStr && newStr ? '\n' : '')
            + (newStr ? newStr.split('\n').map(l => '<span style="color:#3fb950">+ ' + esc(l) + '</span>').join('\n') : '')
            + '</pre>';
        }
        // Drop the reserved estimate before the scrollHeight check below, or an
        // over-estimate would falsely trigger the collapse.
        el.style.minHeight = '';
        // Collapse if rendered height exceeds 240px
        if (el.scrollHeight > 240) {
          const bodyContent = el.closest('.tool-body-content');
          if (bodyContent && !bodyContent.classList.contains('collapsible')) {
            bodyContent.classList.add('collapsible');
            bodyContent.insertAdjacentHTML('beforeend',
              '<span class="clamp-btn" onclick="event.stopPropagation();toggleExpand(this.parentElement)">Show more</span>');
          }
        }
      }, 50);
    }

    const status = resultText(result);
    const statusLabel = status.includes('successfully') ? 'Modified' : (status.includes('Created') ? 'Created' : '');
    return { name: 'Edit', desc: file, fileLink: fullPath, status: statusLabel, body: diffHtml };
  }

  // Render Write tool
  function renderWrite(input, result) {
    const file = shortPath(input.file_path || '');
    return {
      name: 'Write',
      desc: file,
      fileLink: input.file_path || '',
      body: result != null ? `<div class="tool-value clamp" onclick="toggleExpand(this)">${esc(resultText(result))}</div>` : '',
    };
  }

  function renderViewImage(input) {
    const file = input.path || input.file_path || '';
    return {
      name: 'View Image',
      desc: shortPath(file),
      fileLink: file,
      body: '',
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
      body: result != null && resultText(result).trim() ? `<div class="tool-value clamp" onclick="toggleExpand(this)">${ansiHtml(resultText(result))}</div>` : '',
    };
  }

  // Render TodoWrite as checklist
  function renderTodo(input, result) {
    const todos = input.todos || [];
    const explanation = String(input.explanation || '').trim();
    if (!todos.length && !explanation) return { name: 'Update Todos', desc: '', body: '' };
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
    const note = explanation
      ? `<div class="tool-note plan-explanation"><span>Plan note</span>${esc(explanation)}</div>`
      : '';
    const list = html ? `<div style="padding:4px 0">${html}</div>` : '';
    return { name: 'Update Todos', desc: '', body: note + list };
  }

  // Render Agent tool with stats
  function renderAgent(input, result) {
    const desc = input.description || input.subagent_type || '';
    const meta = result?._agentMeta;
    let statsHtml = '';
    if (meta) {
      const secs = Math.round((meta.totalDurationMs || 0) / 1000);
      const calls = meta.totalToolUseCount || 0;
      // Background agent launches with 0/0 stats (meaningless) — only show real counts.
      if (calls > 0 || secs > 0) {
        statsHtml = `<span class="tool-status">${calls} tool calls, ${secs}s</span>`;
      }
    } else if (!result) {
      // No result yet — show running timer with tool_use id for later update
      const timerId = 'timer-' + Math.random().toString(36).slice(2, 8);
      statsHtml = `<span class="tool-status agent-timer" id="${timerId}">0s</span>`;
      setTimeout(() => {
        const start = Date.now();
        const el = document.getElementById(timerId);
        if (!el) return;
        const iv = setInterval(() => {
          const timer = document.getElementById(timerId);
          if (!timer || timer.dataset.stopped) { clearInterval(iv); return; }
          timer.textContent = Math.round((Date.now() - start) / 1000) + 's';
        }, 1000);
      }, 50);
    }
    const bodyText = result ? resultText(result) : '';
    return {
      name: 'Agent',
      desc,
      _statsHtml: statsHtml,
      body: bodyText ? `<div class="tool-value">${esc(bodyText)}</div>` : '',
      collapsible: bodyText.length > 500,
    };
  }

  // Generic fallback
  function renderGeneric(name, input, result) {
    // Cancelled ask/plan: show a clean [Interrupted] instead of CC's long rejection text.
    var out = result != null ? resultText(result) : null;
    if (out != null && out.indexOf(CANCEL_MARK) !== -1) out = '[Interrupted]';
    return {
      name,
      desc: truncate(JSON.stringify(input), 80),
      body: grid([
        ['IN', esc(truncate(JSON.stringify(input, null, 2), 1500))],
        out != null ? ['OUT', ansiHtml(out)] : null,
      ]),
    };
  }

  function codexMcpInfo(input, result) {
    const server = result?.codexMcpServer || input?.codexMcpServer || '';
    const tool = result?.codexMcpTool || input?.codexMcpTool || '';
    return server && tool ? { server, tool } : null;
  }

  function renderCodexMcp(input, result) {
    const invocation = codexMcpInfo(input, result);
    const visibleInput = Object.fromEntries(
      Object.entries(input || {}).filter(([key]) => !key.startsWith('codexMcp')),
    );
    const out = result != null ? resultText(result) : null;
    return {
      name: result ? 'Called' : 'Calling',
      desc: invocation ? `${invocation.server}.${invocation.tool}` : '',
      body: grid([
        ['IN', esc(truncate(JSON.stringify(visibleInput, null, 2), 1500))],
        out != null ? ['OUT', ansiHtml(out)] : null,
      ]),
    };
  }

  function renderWebSearch(input) {
    return {
      name: 'WebSearch',
      desc: input.query || input.url || '',
      body: '',
    };
  }

  function renderTerminalWait(input, result) {
    const command = result?.codexCommand || input.codexCommand || '';
    return {
      name: 'WriteStdin',
      desc: command || `Terminal ${input.session_id || ''}`.trim(),
      body: '',
      expandDesc: !!command,
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

  function isExploreCommand(input, result) {
    return (result?.codexCommandKind || input?.codexCommandKind) === 'explore';
  }

  window.isCodexExploreTool = function (toolUse, result) {
    return toolUse?.name === 'Bash' && isExploreCommand(toolUse.input || {}, result);
  };

  window.isCodexHiddenTool = function (toolUse, result) {
    if (toolUse?.name === 'Bash' && result?.codexBackground === 'running') return true;
    if (toolUse?.name !== 'WriteStdin' || String(toolUse.input?.chars || '').length) return false;
    return !!result && result.codexWait !== 'waiting';
  };

  function codexToolName(name, input, result) {
    if (codexMcpInfo(input, result)) return result ? 'Called' : 'Calling';
    if (name === 'Bash') return isExploreCommand(input, result) ? 'Explored' : 'Ran';
    if (name === 'WriteStdin' && !String(input.chars || '').length) {
      return result ? 'Waited for background terminal' : 'Waiting for background terminal';
    }
    return CODEX_TOOL_NAMES[name] || name;
  }

  function exitCode(result) {
    if (Number.isInteger(result?.codexExitCode)) return result.codexExitCode;
    const match = /Process exited with code\s+(-?\d+)/i.exec(resultText(result));
    return match ? Number(match[1]) : null;
  }

  // Determine error state from result
  function toolState(result, name) {
    if (!result) return '';
    // AskUserQuestion/ExitPlanMode reply via deny carries is_error:true: an answer isn't an error; a cancel is 'warning'.
    if (name === 'AskUserQuestion' || name === 'ExitPlanMode' || name === 'exit_plan_mode') {
      return resultText(result).indexOf(CANCEL_MARK) !== -1 ? 'warning' : '';
    }
    if (result.is_error) return 'error';
    const code = exitCode(result);
    if (code !== null && code !== 0) return 'error';
    // Only check short results (tool stderr/error messages), not long agent outputs
    const t = resultText(result);
    if (t.length < 500) {
      const low = t.toLowerCase();
      if (low.includes('error') || low.includes('failed') || low.includes('permission denied')) return 'error';
    }
    return '';
  }

  // Main: render a tool_use + tool_result pair (wrapping tl-item div is in render.js)
  window.detectLang = detectLang;
  window.toggleToolDesc = function (header) {
    const expanded = header.classList.toggle('expanded-desc');
    header.setAttribute('aria-expanded', String(expanded));
  };

  window.renderToolNode = function (toolUse, toolResult, runtime) {
    const name = toolUse.name || 'Tool';
    const input = toolUse.input || {};
    const codexMcp = runtime === 'codex' && codexMcpInfo(input, toolResult);
    const dispatchers = {
      Bash: () => renderBash(input, toolResult),
      Read: () => renderRead(input, toolResult),
      Edit: () => renderEdit(input, toolResult),
      Write: () => renderWrite(input, toolResult),
      Grep: () => renderSearch('Grep', input, toolResult),
      Glob: () => renderSearch('Glob', input, toolResult),
      ViewImage: () => renderViewImage(input),
      TodoWrite: () => renderTodo(input, toolResult),
      Agent: () => renderAgent(input, toolResult),
      WebSearch: () => renderWebSearch(input),
      WriteStdin: () => !String(input.chars || '').length
        ? renderTerminalWait(input, toolResult)
        : renderGeneric(name, input, toolResult),
    };
    const info = codexMcp
      ? renderCodexMcp(input, toolResult)
      : (dispatchers[name] || (() => renderGeneric(name, input, toolResult)))();
    if (runtime === 'codex') info.name = codexToolName(name, input, toolResult);
    // Store state as data attr for CSS (render.js adds .error/.warning to tl-item)
    window._lastToolState = toolState(toolResult, name);

    const code = exitCode(toolResult);
    const failedStatus = window._lastToolState === 'error' ? (code !== null ? `Exit ${code}` : 'Failed') : '';
    const status = failedStatus || info.status || '';
    const statusHtml = failedStatus
      ? `<span class="tool-status error">${esc(status)}</span>`
      : info._statsHtml || (status ? `<span class="tool-status">${esc(status)}</span>` : '');
    const elevatedHtml = info.elevated ? '<span class="tool-flag">Elevated request</span>' : '';
    const fileLine = info.fileLine || '';
    const matchId = (!fileLine && info.fileLink && (name === 'Edit' || name === 'Write')) ? (toolUse.id || '') : '';
    const descHtml = info.fileLink
      ? `<span class="tool-desc file-link" onclick="event.stopPropagation();openFile('${esc(info.fileLink).replace(/'/g, "\\'")}','${esc(info.desc).replace(/'/g, "\\'")}','${fileLine}','${matchId}')">${esc(info.desc)}</span>`
      : `<span class="tool-desc">${esc(info.desc)}</span>`;
    const id = 'tool-' + Math.random().toString(36).slice(2, 8);

    const noClamp = name === 'TodoWrite';
    const clampClass = noClamp ? ' no-clamp' : (info.collapsible ? ' collapsible' : '');
    const bodyHtml = info.body
      ? `<div class="tool-body">
          <div class="tool-body-content${clampClass}" id="${id}" ${noClamp ? '' : `onclick="toggleExpand(this)"`}>${info.body}</div>
        </div>`
      : '';
    const headerClass = info.expandDesc ? 'tool-header expandable-desc' : 'tool-header';
    const headerAttrs = info.expandDesc
      ? ` role="button" tabindex="0" aria-expanded="false"
        onclick="toggleToolDesc(this)"
        onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleToolDesc(this)}"`
      : '';

    return `<div class="${headerClass}"${headerAttrs}>
        <span class="tool-name">${esc(info.name)}</span>
        ${descHtml}
        ${elevatedHtml}
        ${statusHtml}
      </div>
      ${bodyHtml}`;
  };
})();
