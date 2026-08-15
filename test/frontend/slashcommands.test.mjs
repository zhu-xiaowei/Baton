import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CODEX_MOBILE_COMMANDS } from '../../bridge/codex-commands.mjs';
import { state } from '../../web/js/state.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('slash popup restores cached commands entered before lazy load and coalesces prefetches', async () => {
  const dom = new JSDOM(
    '<!doctype html><body>'
      + '<div id="slash-popup" style="display:none">'
      + '<div class="slash-popup-title">Slash Commands</div><div id="slash-list"></div></div>'
      + '<textarea id="msg-input">/</textarea></body>',
    { url: 'https://test/' },
  );
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.navigator = dom.window.navigator;
  globalThis.localStorage = dom.window.localStorage;
  dom.window.Element.prototype.scrollIntoView = function () {};

  state.appState = {
    runtime: 'claude',
    device: 'phone',
    project: { hash: '-workspace-project' },
    session: 'claude-session-cached',
  };
  state.wsProjectHash = '-workspace-project';
  state.wsSessionId = 'claude-session-cached';
  dom.window.localStorage.setItem(
    'apeek_cmds:v6:phone:claude:-workspace-project',
    JSON.stringify({
      commands: [{ name: 'model', description: 'Cached model command' }],
      skills: [],
      revision: 'revision-fresh',
      checkedAt: Date.now(),
    }),
  );
  const sent = [];
  dom.window.wsSendReliable = (payload) => sent.push(payload);
  dom.window.updateSendBtn = () => {};

  await import(
    pathToFileURL(path.join(ROOT, 'web/js/components/slashcommands.js')).href
      + `?lazy-cache-test=${Date.now()}`
  );

  assert.equal(dom.window.document.querySelector('#slash-popup').style.display, 'block');
  assert.equal(
    dom.window.document.querySelector('.slash-command-name').textContent,
    '/model',
  );
  assert.equal(sent.length, 0);
  dom.window.prefetchCommands();
  assert.equal(sent.length, 0);
  state.appState.session = 'claude-session-2';
  state.wsSessionId = 'claude-session-2';
  dom.window.prefetchCommands();
  assert.equal(sent.length, 0);

  state.appState.project = { hash: '-workspace-empty' };
  state.wsProjectHash = '-workspace-empty';
  dom.window.prefetchCommands();
  dom.window.prefetchCommands();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, 'list_commands');
  assert.equal(sent[0].knownRevision, '');

  dom.window.resetCommandRequest();
  dom.window.prefetchCommands();
  assert.equal(sent.length, 2);
});

test('expired slash cache validates by revision without replacing unchanged content', async () => {
  const dom = new JSDOM(
    '<!doctype html><body>'
      + '<div id="slash-popup" style="display:none">'
      + '<div class="slash-popup-title">Slash Commands</div><div id="slash-list"></div></div>'
      + '<textarea id="msg-input">/</textarea></body>',
    { url: 'https://test/' },
  );
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.navigator = dom.window.navigator;
  globalThis.localStorage = dom.window.localStorage;
  dom.window.Element.prototype.scrollIntoView = function () {};
  state.appState = {
    runtime: 'claude',
    device: 'phone',
    project: { hash: '-workspace-expired' },
    session: 'claude-expired',
  };
  state.wsProjectHash = '-workspace-expired';
  state.wsSessionId = 'claude-expired';
  const cacheKey = 'apeek_cmds:v6:phone:claude:-workspace-expired';
  dom.window.localStorage.setItem(cacheKey, JSON.stringify({
    commands: [{ name: 'model', description: 'Cached model command' }],
    skills: [],
    revision: 'revision-1',
    checkedAt: 1,
  }));
  const sent = [];
  dom.window.wsSendReliable = (payload) => sent.push(payload);

  await import(
    pathToFileURL(path.join(ROOT, 'web/js/components/slashcommands.js')).href
      + `?revision-test=${Date.now()}`
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].knownRevision, 'revision-1');
  assert.equal(sent[0].sessionId, undefined);
  assert.equal(dom.window.document.querySelector('.slash-command-name').textContent, '/model');
  state.appState.session = 'claude-another-session';
  state.wsSessionId = 'claude-another-session';
  dom.window.handleCommandsList({
    action: 'commands_list',
    requestId: sent[0].requestId,
    runtime: 'claude',
    device: 'phone',
    projectHash: '-workspace-expired',
    revision: 'revision-1',
    notModified: true,
  });
  assert.equal(dom.window.document.querySelector('.slash-command-name').textContent, '/model');
  const stored = JSON.parse(dom.window.localStorage.getItem(cacheKey));
  assert.equal(stored.revision, 'revision-1');
  assert.ok(stored.checkedAt > 1);
  dom.window.prefetchCommands();
  assert.equal(sent.length, 1);
});

test('stale not-modified response keeps the frontend cache expired for retry', async () => {
  const dom = new JSDOM(
    '<!doctype html><body>'
      + '<div id="slash-popup" style="display:none">'
      + '<div class="slash-popup-title">Slash Commands</div><div id="slash-list"></div></div>'
      + '<textarea id="msg-input">/</textarea></body>',
    { url: 'https://test/' },
  );
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.navigator = dom.window.navigator;
  globalThis.localStorage = dom.window.localStorage;
  dom.window.Element.prototype.scrollIntoView = function () {};
  state.appState = {
    runtime: 'claude',
    device: 'phone',
    project: { hash: '-workspace-stale' },
    session: 'claude-stale',
  };
  state.wsProjectHash = '-workspace-stale';
  state.wsSessionId = 'claude-stale';
  const cacheKey = 'apeek_cmds:v6:phone:claude:-workspace-stale';
  dom.window.localStorage.setItem(cacheKey, JSON.stringify({
    commands: [{ name: 'model' }],
    skills: [],
    revision: 'revision-stale',
    checkedAt: 1,
  }));
  const sent = [];
  dom.window.wsSendReliable = (payload) => sent.push(payload);
  await import(
    pathToFileURL(path.join(ROOT, 'web/js/components/slashcommands.js')).href
      + `?stale-test=${Date.now()}`
  );
  dom.window.handleCommandsList({
    action: 'commands_list',
    requestId: sent[0].requestId,
    runtime: 'claude',
    device: 'phone',
    projectHash: '-workspace-stale',
    sessionId: 'claude-stale',
    revision: 'revision-stale',
    notModified: true,
    stale: true,
    error: 'runtime unavailable',
  });
  assert.equal(JSON.parse(dom.window.localStorage.getItem(cacheKey)).checkedAt, 1);
  dom.window.prefetchCommands();
  assert.equal(sent.length, 2);
});

test('changed slash catalog refreshes the open top-level menu without losing selection', async () => {
  const dom = new JSDOM(
    '<!doctype html><body>'
      + '<div id="slash-popup" style="display:none">'
      + '<div class="slash-popup-title">Slash Commands</div><div id="slash-list"></div></div>'
      + '<textarea id="msg-input">/</textarea></body>',
    { url: 'https://test/' },
  );
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.navigator = dom.window.navigator;
  globalThis.localStorage = dom.window.localStorage;
  dom.window.Element.prototype.scrollIntoView = function () {};
  state.appState = {
    runtime: 'claude',
    device: 'phone',
    project: { hash: '-workspace-changed' },
    session: 'claude-changed',
  };
  state.wsProjectHash = '-workspace-changed';
  state.wsSessionId = 'claude-changed';
  const cacheKey = 'apeek_cmds:v6:phone:claude:-workspace-changed';
  dom.window.localStorage.setItem(cacheKey, JSON.stringify({
    commands: [
      { name: 'model', description: 'Cached model command' },
      { name: 'usage', description: 'Cached usage command' },
    ],
    skills: [],
    revision: 'revision-old',
    checkedAt: 1,
  }));
  const sent = [];
  dom.window.wsSendReliable = (payload) => sent.push(payload);
  await import(
    pathToFileURL(path.join(ROOT, 'web/js/components/slashcommands.js')).href
      + `?changed-test=${Date.now()}`
  );
  const input = dom.window.document.getElementById('msg-input');
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
    key: 'ArrowDown',
    bubbles: true,
    cancelable: true,
  }));
  assert.equal(
    dom.window.document.querySelector('.slash-item.active .slash-command-name').textContent,
    '/usage',
  );

  dom.window.handleCommandsList({
    action: 'commands_list',
    requestId: sent[0].requestId,
    runtime: 'claude',
    device: 'phone',
    projectHash: '-workspace-changed',
    sessionId: 'claude-changed',
    revision: 'revision-new',
    commands: [
      { name: 'model', description: 'Fresh model command' },
      { name: 'usage', description: 'Fresh usage command' },
      { name: 'stats', description: 'Fresh stats command' },
    ],
    skills: [],
  });
  assert.deepEqual(
    [...dom.window.document.querySelectorAll('.slash-command-name')]
      .map((element) => element.textContent),
    ['/model', '/usage', '/stats'],
  );
  assert.equal(
    dom.window.document.querySelector('.slash-item.active .slash-command-name').textContent,
    '/usage',
  );
  assert.equal(JSON.parse(dom.window.localStorage.getItem(cacheKey)).revision, 'revision-new');
});

test('Codex slash popup preserves bridge order and opens the native-style skill picker', async () => {
  const dom = new JSDOM(
    '<!doctype html><body>'
      + '<div id="slash-popup" style="display:none">'
      + '<div class="slash-popup-title">Slash Commands</div><div id="slash-list"></div></div>'
      + '<textarea id="msg-input"></textarea></body>',
    { url: 'https://test/' },
  );
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.navigator = dom.window.navigator;
  globalThis.localStorage = dom.window.localStorage;
  dom.window.Element.prototype.scrollIntoView = function () {};

  state.appState = {
    runtime: 'codex',
    device: 'phone',
    project: { hash: '-workspace-project' },
    session: 'codex:thread-1',
  };
  state.wsProjectHash = '-workspace-project';
  state.wsSessionId = 'codex:thread-1';

  const sent = [];
  let sends = 0;
  dom.window.wsSend = (payload) => sent.push(payload);
  dom.window.sendMessage = () => { sends++; };
  dom.window.updateSendBtn = () => {};
  dom.window.localStorage.setItem(
    'apeek_cmds:v2:phone:codex:-workspace-project',
    JSON.stringify({
      commands: [{ name: 'agents', description: 'Polluted Claude cache' }],
      skills: [],
    }),
  );

  await import(
    pathToFileURL(path.join(ROOT, 'web/js/components/slashcommands.js')).href
      + `?test=${Date.now()}`
  );

  dom.window.prefetchCommands();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].runtime, 'codex');
  assert.equal(sent[0].sessionId, undefined);

  const input = dom.window.document.getElementById('msg-input');
  input.value = '/';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

  dom.window.handleCommandsList({
    action: 'commands_list',
    requestId: sent[0].requestId,
    commands: [{
      name: 'agents',
      description: 'Old Claude-only response',
      behavior: 'send',
    }],
  });
  assert.equal(dom.window.document.querySelectorAll('.slash-item').length, 0);

  const names = CODEX_MOBILE_COMMANDS.map((command) => command.name)
    .concat('prompts:legacy');
  dom.window.handleCommandsList({
    action: 'commands_list',
    requestId: sent[0].requestId,
    runtime: 'codex',
    projectHash: '-workspace-project',
    sessionId: 'codex:thread-1',
    revision: 'codex-revision',
    commands: CODEX_MOBILE_COMMANDS.map((command) => ({
      ...command,
      description: `Description for ${command.name}`,
      ...(command.name === 'agent' ? { optionsRemote: true } : {}),
      options: command.name === 'model'
        ? [{
          name: 'openai.gpt-5.6-sol:high',
          label: 'GPT-5.6 Sol · high',
          description: 'Greater reasoning depth',
          value: 'openai.gpt-5.6-sol high',
        }]
        : [],
    })).concat({
      name: 'prompts:legacy',
      description: 'Description for prompts:legacy',
      behavior: 'send',
    }),
    skills: [
      { name: 'reviewer', description: 'Review code' },
      { name: 'tester', description: 'Run tests' },
    ],
  });

  assert.deepEqual(
    [...dom.window.document.querySelectorAll('.slash-command-name')].map((element) => element.textContent),
    names.map((name) => `/${name}`),
  );

  const rename = [...dom.window.document.querySelectorAll('.slash-item')]
    .find((element) => element.querySelector('.slash-command-name').textContent === '/rename');
  rename.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(input.value, '/rename ');
  assert.equal(sends, 0);

  input.value = '/';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const skills = [...dom.window.document.querySelectorAll('.slash-item')]
    .find((element) => element.querySelector('.slash-command-name').textContent === '/skills');
  skills
    .dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(dom.window.document.querySelector('.slash-popup-title').textContent, 'Skills');
  assert.deepEqual(
    [...dom.window.document.querySelectorAll('.slash-command-name')].map((element) => element.textContent),
    ['$reviewer', '$tester'],
  );
  assert.ok(dom.window.document.querySelector('.slash-back'));
  dom.window.document.querySelector('.slash-back')
    .dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  assert.equal(dom.window.document.querySelector('.slash-popup-title').textContent, 'Slash Commands');
  assert.equal(dom.window.document.querySelector('#slash-popup').style.display, 'block');
  assert.equal(input.value, '/');
  assert.equal(
    dom.window.document.querySelector('.slash-item.active .slash-command-name').textContent,
    '/skills',
  );

  const reopenedSkills = [...dom.window.document.querySelectorAll('.slash-item')]
    .find((element) => element.querySelector('.slash-command-name').textContent === '/skills');
  reopenedSkills.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
  dom.window.document.querySelector('.slash-item')
    .dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(input.value, '$reviewer ');
  assert.equal(sends, 0);

  input.value = '/';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.document.querySelector('.slash-item')
    .dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(dom.window.document.querySelector('.slash-popup-title').textContent, '/model');
  assert.equal(
    dom.window.document.querySelector('.slash-command-name').textContent,
    'GPT-5.6 Sol · high',
  );
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
    key: 'ArrowLeft',
    bubbles: true,
    cancelable: true,
  }));
  assert.equal(dom.window.document.querySelector('.slash-popup-title').textContent, 'Slash Commands');
  assert.equal(input.value, '/');
  assert.equal(
    dom.window.document.querySelector('.slash-item.active .slash-command-name').textContent,
    '/model',
  );

  dom.window.document.querySelector('.slash-item.active')
    .dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
  dom.window.document.querySelector('.slash-item')
    .dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(input.value, '/model openai.gpt-5.6-sol high');
  assert.equal(sends, 1);

  input.value = '/';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const agent = [...dom.window.document.querySelectorAll('.slash-item')]
    .find((element) => element.querySelector('.slash-command-name').textContent === '/agent');
  agent.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(sent.at(-1).action, 'list_command_options');
  assert.equal(sent.at(-1).commandName, 'agent');
  assert.equal(dom.window.document.querySelector('.slash-command-name').textContent, 'Loading...');

  const optionsRequest = sent.at(-1);
  dom.window.handleCommandOptions({
    action: 'command_options',
    requestId: optionsRequest.requestId,
    commandName: 'agent',
    runtime: 'codex',
    device: 'phone',
    projectHash: '-workspace-project',
    sessionId: 'codex:thread-1',
    options: [{
      name: 'thread-2',
      label: 'Reviewer',
      description: 'reviewer · completed',
      value: 'thread-2',
    }],
  });
  assert.equal(dom.window.document.querySelector('.slash-popup-title').textContent, '/agent');
  assert.equal(dom.window.document.querySelector('.slash-command-name').textContent, 'Reviewer');

  dom.window.handleCommandsList({
    action: 'commands_list',
    requestId: sent[0].requestId,
    runtime: 'codex',
    device: 'phone',
    projectHash: '-workspace-project',
    sessionId: 'codex:thread-1',
    revision: 'codex-revision-2',
    commands: [{ name: 'new-command', behavior: 'send' }],
    skills: [],
  });
  assert.equal(dom.window.document.querySelector('.slash-popup-title').textContent, '/agent');
  assert.equal(dom.window.document.querySelector('.slash-command-name').textContent, 'Reviewer');
});

test('Claude slash popup preserves live TUI order and opens realtime model options', async () => {
  const dom = new JSDOM(
    '<!doctype html><body>'
      + '<div id="slash-popup" style="display:none">'
      + '<div class="slash-popup-title">Slash Commands</div><div id="slash-list"></div></div>'
      + '<textarea id="msg-input"></textarea></body>',
    { url: 'https://test/' },
  );
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.navigator = dom.window.navigator;
  globalThis.localStorage = dom.window.localStorage;
  dom.window.Element.prototype.scrollIntoView = function () {};

  state.appState = {
    runtime: 'claude',
    device: 'phone',
    project: { hash: '-workspace-project' },
    session: 'claude-session-1',
  };
  state.wsProjectHash = '-workspace-project';
  state.wsSessionId = 'claude-session-1';

  const sent = [];
  let sends = 0;
  dom.window.wsSend = (payload) => sent.push(payload);
  dom.window.sendMessage = () => { sends++; };
  dom.window.updateSendBtn = () => {};

  await import(
    pathToFileURL(path.join(ROOT, 'web/js/components/slashcommands.js')).href
      + `?claude-test=${Date.now()}`
  );
  dom.window.prefetchCommands();
  const input = dom.window.document.getElementById('msg-input');
  input.value = '/';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.handleCommandsList({
    action: 'commands_list',
    requestId: sent[0].requestId,
    runtime: 'claude',
    projectHash: '-workspace-project',
    sessionId: 'claude-session-1',
    revision: 'claude-revision',
    commands: [
      {
        name: 'model',
        description: 'Set the AI model for Claude Code',
        argumentHint: '<model>',
        behavior: 'picker',
        options: [
          {
            name: 'default',
            label: 'Default',
            value: 'default',
            description: 'Use the account default',
          },
          {
            name: 'opus',
            label: 'Opus',
            value: 'opus',
            description: 'Most capable',
          },
        ],
      },
      {
        name: 'audit',
        description: 'A deliberately long custom command description supplied by Claude Code.',
        argumentHint: '[path]',
        behavior: 'compose',
      },
    ],
  });

  assert.deepEqual(
    [...dom.window.document.querySelectorAll('.slash-command-name')]
      .map((element) => element.textContent),
    ['/model', '/audit'],
  );
  assert.equal(
    dom.window.document.querySelectorAll('.slash-argument-hint')[1].textContent,
    '[path]',
  );
  assert.equal(
    dom.window.document.querySelectorAll('.slash-description')[1].textContent,
    'A deliberately long custom command description supplied by Claude Code.',
  );

  dom.window.document.querySelector('.slash-item')
    .dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(dom.window.document.querySelector('.slash-popup-title').textContent, '/model');
  assert.deepEqual(
    [...dom.window.document.querySelectorAll('.slash-command-name')]
      .map((element) => element.textContent),
    ['Default', 'Opus'],
  );
  dom.window.document.querySelectorAll('.slash-item')[1]
    .dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(input.value, '/model opus');
  assert.equal(sends, 1);
});
