import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body></body>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

await import('../../web/js/components/tool.js');
globalThis.renderToolNode = window.renderToolNode;
globalThis.renderAssistantText = (text) => text;
globalThis.renderThinking = () => '';
globalThis.renderUserBubble = () => '';
globalThis.renderSystemEvent = () => '';
globalThis.renderSummary = () => '';
globalThis.renderInterrupt = () => '';
globalThis.renderLocalCommandStdout = () => '';
globalThis.isToolResultOnly = (message) => Array.isArray(message.content)
  && message.content.length > 0
  && message.content.every((block) => block.type === 'tool_result');
globalThis.isInterruptMsg = () => false;
globalThis.isLocalCommandStdout = () => false;
await import('../../web/js/render.js');

test('Codex WebSearch renders as a completed web search node', () => {
  const html = window.renderToolNode({
    type: 'tool_use',
    id: 'web-1',
    name: 'WebSearch',
    input: {
      action: 'search',
      query: 'site:example.com filesystem watcher',
    },
  }, {
    type: 'tool_result',
    tool_use_id: 'web-1',
    content: 'Searched the web for site:example.com filesystem watcher',
    is_error: false,
  }, 'codex');

  assert.match(html, /Searched the web/);
  assert.match(html, /site:example\.com filesystem watcher/);
  assert.doesNotMatch(html, /Failed/);
});

test('Codex MCP calls render Calling or Called while Claude keeps the tool name', () => {
  const toolUse = {
    type: 'tool_use',
    id: 'mcp-1',
    name: 'js',
    input: {
      code: 'nodeRepl.write("ok")',
      timeout_ms: 30_000,
      codexMcpServer: 'node_repl',
      codexMcpTool: 'js',
    },
  };
  const result = {
    type: 'tool_result',
    tool_use_id: 'mcp-1',
    content: 'ok',
    is_error: false,
    codexMcpServer: 'node_repl',
    codexMcpTool: 'js',
  };

  const calling = window.renderToolNode(toolUse, null, 'codex');
  assert.match(calling, />Calling</);
  assert.match(calling, />node_repl\.js</);
  assert.doesNotMatch(calling, /codexMcpServer/);

  const called = window.renderToolNode(toolUse, result, 'codex');
  assert.match(called, />Called</);
  assert.match(called, />node_repl\.js</);
  assert.match(called, />ok</);

  const claude = window.renderToolNode(toolUse, result, 'claude');
  assert.match(claude, />js</);
  assert.doesNotMatch(claude, />Called</);
  assert.doesNotMatch(claude, />Calling</);
});

test('Codex background command completion keeps the original Ran label', () => {
  const html = window.renderToolNode({
    type: 'tool_use',
    id: 'bash-1',
    name: 'Bash',
    input: {
      command: 'sleep 1; echo done',
    },
  }, {
    type: 'tool_result',
    tool_use_id: 'bash-1',
    content: 'done\nProcess exited with code 0',
    is_error: false,
    codexBackground: 'complete',
    codexCommandKind: 'ran',
  }, 'codex');

  assert.match(html, /Ran/);
  assert.match(html, /sleep 1; echo done/);
  assert.doesNotMatch(html, /Waited for background terminal/);
  assert.doesNotMatch(html, /Failed/);
});

test('Codex ignores the legacy Waited label on Bash results', () => {
  const html = window.renderToolNode({
    type: 'tool_use',
    id: 'bash-legacy',
    name: 'Bash',
    input: {
      command: 'npm test',
      codexCommandKind: 'ran',
    },
  }, {
    type: 'tool_result',
    tool_use_id: 'bash-legacy',
    content: 'tests passed',
    is_error: false,
    codexCommandKind: 'ran',
    codexLabel: 'Waited for background terminal',
  }, 'codex');

  assert.match(html, /Ran/);
  assert.match(html, /npm test/);
  assert.doesNotMatch(html, /Waited for background terminal/);
});

test('Codex keeps a foreground Ran before a later Explore call', () => {
  const messages = [{
    uuid: 'get-use',
    type: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'get',
      name: 'Bash',
      input: {
        command: 'aws dynamodb get-item',
        codexCommandKind: 'ran',
      },
    }],
    timestamp: '2026-08-10T03:52:36.095Z',
  }, {
    uuid: 'read-use',
    type: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'read',
      name: 'Bash',
      input: {
        command: "sed -n '1,340p' test/frontend/tool-render.test.mjs",
        codexCommandKind: 'explore',
        codexCommandActions: [{
          type: 'read',
          name: 'tool-render.test.mjs',
          path: 'test/frontend/tool-render.test.mjs',
        }],
      },
    }],
    timestamp: '2026-08-10T03:52:37.680Z',
  }, {
    uuid: 'get-result',
    type: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'get',
      content: '{"uuid":"example"}',
      codexCommandKind: 'ran',
    }],
    timestamp: '2026-08-10T03:52:37.733Z',
  }, {
    uuid: 'read-result',
    type: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'read',
      content: 'test contents',
      codexCommandKind: 'explore',
    }],
    timestamp: '2026-08-10T03:52:37.769Z',
  }];

  document.body.innerHTML = `<div class="messages">${window.renderMessages(messages, 'codex')}</div>`;
  const labels = Array.from(document.querySelectorAll('.tool-name'))
    .map((node) => node.textContent);
  const descriptions = Array.from(document.querySelectorAll('.tool-desc'))
    .map((node) => node.textContent);

  assert.deepEqual(labels, ['Ran', 'Explored']);
  assert.deepEqual(descriptions, ['aws dynamodb get-item', 'Read tool-render.test.mjs']);
});

test('Codex history orders mixed Ran and Explored cells by completion', () => {
  const use = (uuid, id, command, timestamp, input = {}) => ({
    uuid,
    type: 'assistant',
    content: [{
      type: 'tool_use',
      id,
      name: 'Bash',
      input: { command, codexCommandKind: 'ran', ...input },
    }],
    timestamp,
  });
  const result = (uuid, id, timestamp, kind) => ({
    uuid,
    type: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: id,
      content: 'done',
      codexCommandKind: kind,
    }],
    timestamp,
  });
  const messages = [
    use('version-use', 'version', 'node check-version.mjs', '2026-08-10T04:31:52.683Z'),
    use('scan-use', 'scan', 'aws dynamodb scan', '2026-08-10T04:31:52.928Z'),
    use('local-use', 'local', 'printf local-version', '2026-08-10T04:31:53.097Z'),
    use('search-use', 'search', 'rg bridge_recovery_complete', '2026-08-10T04:31:53.306Z', {
      codexCommandKind: 'explore',
      codexCommandActions: [{
        type: 'search',
        query: 'bridge_recovery_complete',
        path: 'ws-*.js',
      }],
    }),
    result('local-result', 'local', '2026-08-10T04:31:53.296Z', 'ran'),
    result('search-result', 'search', '2026-08-10T04:31:53.398Z', 'explore'),
    result('scan-result', 'scan', '2026-08-10T04:31:54.244Z', 'ran'),
    result('version-result', 'version', '2026-08-10T04:31:55.838Z', 'ran'),
  ];

  document.body.innerHTML = `<div class="messages">${window.renderMessages(messages, 'codex')}</div>`;
  assert.deepEqual(
    Array.from(document.querySelectorAll('.tool-desc')).map((node) => node.textContent),
    [
      'printf local-version',
      'Search bridge_recovery_complete',
      'aws dynamodb scan',
      'node check-version.mjs',
    ],
  );
});

test('Codex exploration calls share one visible group label and empty waits stay hidden', () => {
  const tool = (id, name, input) => ({
    uuid: `message-${id}`,
    type: 'assistant',
    content: [{ type: 'tool_use', id, name, input }],
    timestamp: `2026-08-10T02:26:${id.slice(-2)}.000Z`,
  });
  const html = window.renderMessages([
    tool('search-01', 'Bash', {
      command: 'rg -n "tool_use_id" web/js',
      codexCommandKind: 'explore',
      codexCommandActions: [{ type: 'search', query: 'tool_use_id', path: 'web/js' }],
    }),
    tool('search-02', 'Bash', {
      command: 'rg -n "CommandExecution" bridge',
      codexCommandKind: 'explore',
      codexCommandActions: [{ type: 'search', query: 'CommandExecution', path: 'bridge' }],
    }),
    tool('read-03', 'Bash', {
      command: "sed -n '1,120p' web/js/render.js",
      codexCommandKind: 'explore',
      codexCommandActions: [{ type: 'read', name: 'render.js', path: 'web/js/render.js' }],
    }),
    tool('wait-04', 'WriteStdin', { session_id: 1234, chars: '' }),
    {
      uuid: 'result-wait-04',
      type: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'wait-04',
        content: 'Process exited with code 0',
        codexWait: 'completed',
      }],
      timestamp: '2026-08-10T02:26:05.000Z',
    },
  ], 'codex');

  document.body.innerHTML = `<div class="messages">${html}</div>`;
  const container = document.querySelector('.messages');
  window.markCodexExploreGroups(container);

  assert.equal(container.querySelectorAll('.codex-explore').length, 3);
  assert.equal(container.querySelectorAll('.codex-explore-continuation').length, 2);
  assert.equal(container.querySelectorAll('.codex-explore:not(.codex-explore-continuation)').length, 1);
  assert.equal(container.querySelectorAll('.codex-explore-group-start').length, 1);
  assert.equal(container.querySelectorAll('.codex-explore-group-connected').length, 0);
  assert.deepEqual(Array.from(container.querySelectorAll('.tool-desc')).map((node) => node.textContent), [
    'Search tool_use_id',
    'Search CommandExecution',
    'Read render.js',
  ]);
  assert.doesNotMatch(html, /wait-04/);
  const css = fs.readFileSync(new URL('../../web/css/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.codex-explore-continuation \.tool-name \{ display: none; \}/);
  assert.match(css, /\.codex-explore-continuation::before \{ display: none; \}/);
  assert.match(css, /\.codex-explore-continuation::after \{ display: none !important; \}/);
  assert.match(css, /\.codex-explore-group-start::after \{[\s\S]*bottom: calc\(100% - 16px\) !important;/);
  assert.match(css, /\.codex-explore-group-start\.codex-explore-group-connected::after \{[\s\S]*bottom: -2px !important;/);
  assert.match(css, /\.codex-explore-continuation\.codex-explore-group-connected::after \{[\s\S]*display: block !important;/);
});

test('Codex Waited command expands from its truncated header', () => {
  const command = "target='0.2.0-codex-p2-20260810-11'; for i in 1 2 3 4 5 6 7; do echo \"$target\"; done";
  const html = window.renderMessages([
    {
      uuid: 'wait-use',
      type: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'wait',
        name: 'WriteStdin',
        input: { session_id: 1234, chars: '', codexCommand: command },
      }],
      timestamp: '2026-08-10T04:00:00.000Z',
    },
    {
      uuid: 'wait-result',
      type: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'wait',
        content: 'Process running with session ID 1234',
        codexWait: 'waiting',
        codexProcessId: '1234',
        codexCommand: command,
      }],
      timestamp: '2026-08-10T04:00:01.000Z',
    },
  ], 'codex');

  document.body.innerHTML = `<div class="messages">${html}</div>`;
  const header = document.querySelector('.codex-terminal-wait .tool-header');
  assert.ok(header.classList.contains('expandable-desc'));
  assert.equal(header.getAttribute('aria-expanded'), 'false');
  assert.equal(header.querySelector('.tool-desc').textContent, command);

  window.toggleToolDesc(header);
  assert.ok(header.classList.contains('expanded-desc'));
  assert.equal(header.getAttribute('aria-expanded'), 'true');

  window.toggleToolDesc(header);
  assert.equal(header.classList.contains('expanded-desc'), false);
  assert.equal(header.getAttribute('aria-expanded'), 'false');
});

test('Codex background waits and completions follow the TUI transcript order', () => {
  const tool = (id, name, input, timestamp) => ({
    uuid: `message-${id}`,
    type: 'assistant',
    content: [{ type: 'tool_use', id, name, input }],
    timestamp,
  });
  const result = (id, content, timestamp, extra = {}) => ({
    uuid: `result-${id}-${timestamp}`,
    type: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }],
    timestamp,
  });
  const text = (value, timestamp) => ({
    uuid: `text-${timestamp}`,
    type: 'assistant',
    content: [{ type: 'text', text: value }],
    timestamp,
  });
  const messages = [
    text('Before commands', '2026-08-10T03:00:00.000Z'),
    tool('npm', 'Bash', { command: 'npm test', codexCommandKind: 'ran' }, '2026-08-10T03:00:01.000Z'),
    tool('sleep', 'Bash', { command: 'sleep 75; check fleet', codexCommandKind: 'ran' }, '2026-08-10T03:00:02.000Z'),
    result('npm', 'tests passed', '2026-08-10T03:00:05.000Z', {
      codexBackground: 'complete',
      codexCommandKind: 'ran',
      codexProcessId: '100',
    }),
    tool('wait-npm', 'WriteStdin', { session_id: 100, chars: '' }, '2026-08-10T03:00:03.000Z'),
    result('wait-npm', 'Process exited with code 0', '2026-08-10T03:00:05.100Z', {
      codexWait: 'completed',
      codexProcessId: '100',
    }),
    tool('wait-sleep', 'WriteStdin', {
      session_id: 200,
      chars: '',
      codexCommand: 'sleep 75; check fleet',
    }, '2026-08-10T03:00:06.000Z'),
    result('wait-sleep', 'Process running with session ID 200', '2026-08-10T03:00:06.500Z', {
      codexWait: 'waiting',
      codexProcessId: '200',
      codexCommand: 'sleep 75; check fleet',
    }),
    tool('date', 'Bash', { command: 'date; check versions', codexCommandKind: 'ran' }, '2026-08-10T03:00:06.750Z'),
    tool('tail', 'Bash', { command: 'tail bridge.log', codexCommandKind: 'ran' }, '2026-08-10T03:00:07.000Z'),
    result('tail', 'bridge ready', '2026-08-10T03:00:07.100Z', { codexCommandKind: 'ran' }),
    tool('git', 'Bash', {
      command: 'git diff --stat; git diff --check; find test -type f',
      codexCommandKind: 'ran',
    }, '2026-08-10T03:00:08.000Z'),
    result('git', 'test/a.test.mjs', '2026-08-10T03:00:08.100Z', { codexCommandKind: 'ran' }),
    result('date', 'all online', '2026-08-10T03:00:09.100Z', { codexCommandKind: 'ran' }),
    text('After wait', '2026-08-10T03:00:10.000Z'),
    tool('next', 'Bash', {
      command: 'sleep 35; check versions',
      codexCommandKind: 'ran',
    }, '2026-08-10T03:00:10.100Z'),
    tool('wait-next', 'WriteStdin', {
      session_id: 300,
      chars: '',
      codexCommand: 'sleep 35; check versions',
    }, '2026-08-10T03:00:10.500Z'),
    result('wait-next', 'Process running with session ID 300', '2026-08-10T03:00:11.000Z', {
      codexWait: 'waiting',
      codexProcessId: '300',
      codexCommand: 'sleep 35; check versions',
    }),
    result('sleep', 'fleet checked', '2026-08-10T03:00:12.000Z', {
      codexBackground: 'complete',
      codexCommandKind: 'ran',
      codexProcessId: '200',
    }),
    tool('wait-next-again', 'WriteStdin', {
      session_id: 300,
      chars: '',
      codexCommand: 'sleep 35; check versions',
    }, '2026-08-10T03:00:13.000Z'),
    result('wait-next-again', 'Process running with session ID 300', '2026-08-10T03:00:13.500Z', {
      codexWait: 'waiting',
      codexProcessId: '300',
      codexCommand: 'sleep 35; check versions',
    }),
    result('next', 'versions checked', '2026-08-10T03:00:14.000Z', {
      codexBackground: 'complete',
      codexCommandKind: 'ran',
      codexProcessId: '300',
    }),
  ];

  document.body.innerHTML = `<div class="messages">${window.renderMessages(messages, 'codex')}</div>`;
  const container = document.querySelector('.messages');
  window.markCodexExploreGroups(container);

  const timeline = Array.from(container.querySelectorAll('.tl-item')).map((node) => ({
    label: node.querySelector('.tool-name')?.textContent || '',
    text: node.textContent,
  }));
  assert.deepEqual(timeline.map((item) => item.label), [
    '',
    'Ran',
    'Ran',
    'Ran',
    'Ran',
    'Waited for background terminal',
    '',
    'Ran',
    'Waited for background terminal',
    'Ran',
  ]);
  assert.match(timeline[2].text, /tail bridge\.log/);
  assert.match(timeline[3].text, /git diff --stat/);
  assert.match(timeline[4].text, /date; check versions/);
  assert.match(timeline[5].text, /sleep 75; check fleet/);
  assert.match(timeline[7].text, /sleep 75; check fleet/);
  assert.match(timeline[8].text, /sleep 35; check versions/);
  assert.match(timeline[9].text, /sleep 35; check versions/);
  assert.equal(container.querySelectorAll('.codex-terminal-wait').length, 2);
});

test('Codex non-empty terminal input remains visible', () => {
  const html = window.renderMessages([{
    uuid: 'message-input',
    type: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'stdin-input',
      name: 'WriteStdin',
      input: { session_id: 1234, chars: 'yes\n' },
    }],
    timestamp: '2026-08-10T02:27:00.000Z',
  }], 'codex');

  assert.match(html, /stdin-input/);
  assert.match(html, /Ran/);
});

test('Codex exploration grouping spans adjacent realtime assistant turns', () => {
  document.body.innerHTML = `<div class="messages">
    <div class="assistant-turn"><div class="tl-item tool-node codex-explore"></div></div>
    <div class="assistant-turn"><div class="tl-item tool-node codex-explore"></div></div>
    <div class="assistant-turn"><div class="tl-item tool-node"></div></div>
    <div class="assistant-turn"><div class="tl-item tool-node codex-explore"></div></div>
  </div>`;
  const container = document.querySelector('.messages');

  window.markCodexExploreGroups(container);

  const explores = container.querySelectorAll('.codex-explore');
  assert.equal(explores[0].classList.contains('codex-explore-continuation'), false);
  assert.equal(explores[0].classList.contains('codex-explore-group-start'), true);
  assert.equal(explores[0].classList.contains('codex-explore-group-connected'), true);
  assert.equal(explores[1].classList.contains('codex-explore-continuation'), true);
  assert.equal(explores[1].classList.contains('codex-explore-group-connected'), true);
  assert.equal(explores[2].classList.contains('codex-explore-continuation'), false);
});
