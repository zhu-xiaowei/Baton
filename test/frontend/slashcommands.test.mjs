import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CODEX_MOBILE_COMMANDS } from '../../bridge/codex-commands.mjs';
import { state } from '../../web/js/state.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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
  assert.equal(sent[0].sessionId, 'codex:thread-1');

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
    commands: CODEX_MOBILE_COMMANDS.map((command) => ({
      ...command,
      description: `Description for ${command.name}`,
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
