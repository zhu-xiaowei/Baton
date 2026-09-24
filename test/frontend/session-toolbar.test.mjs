import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createTestServer } from './helpers/vite.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CSS = readFileSync(path.join(ROOT, 'web/css/style.css'), 'utf8');

test('session toolbar exposes the terminal without losing runtime or agent controls', async context => {
  const dom = new JSDOM('<!doctype html><head><style>' + CSS + '</style></head><body>'
    + '<div class="top-bar"><div class="top-left"><span class="top-logo" aria-hidden="true">'
    + '<img src="assets/baton-logo.svg" alt=""></span></div><div id="top-right"></div></div>'
    + '<div id="breadcrumb" class="breadcrumb"></div><div id="content">Existing conversation</div>'
    + '<div id="input-bar"><textarea id="msg-input"></textarea><button id="send-btn"></button></div>'
    + '<button id="scroll-bottom-btn"></button></body>', {
    url: 'https://baton.test/index.html', pretendToBeVisual: true, runScripts: 'dangerously',
  });
  const window = dom.window;
  Object.assign(globalThis, {
    window, document: window.document, navigator: window.navigator,
    location: window.location, history: window.history,
    localStorage: window.localStorage, sessionStorage: window.sessionStorage,
    Element: window.Element, HTMLElement: window.HTMLElement, Node: window.Node, CSS: window.CSS,
    getComputedStyle: window.getComputedStyle,
    requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
    connectWs() {}, disconnectWs() {}, updateSpinner() {}, updateSendBtn() {}, dismissPermissionPrompt() {},
  });
  Object.assign(window, {
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    loadViewerLibs: async () => {},
    __homeLoadPromise: new Promise(() => {}),
    __terminalOpenCalls: [],
  });
  const vite = await createTestServer({
    root: path.join(ROOT, 'web'), logLevel: 'silent', appType: 'custom',
    server: { middlewareMode: true },
    plugins: [{
      name: 'session-toolbar-terminal-fixture', enforce: 'pre',
      resolveId(source, importer) {
        if (source === './terminal.js' && importer?.endsWith('/js/app.js')) return '\0session-toolbar-terminal';
      },
      load(id) {
        if (id === '\0session-toolbar-terminal') {
          return 'export function openProjectTerminal(options) { window.__terminalOpenCalls.push(options); }';
        }
      },
    }],
  });

  try {
    await vite.ssrLoadModule('/js/app.js');
    const state = (await vite.ssrLoadModule('/js/state.js')).state;
    const brandMarkup = document.querySelector('.top-logo').outerHTML;
    function showSession(runtime = 'codex') {
      state.appState = {
        device: 'Mac', project: { hash: 'project', name: 'Project' },
        session: runtime === 'codex' ? 'codex:root' : 'claude-root',
        runtime, sessionPreview: '这个文档写的是什么 [' + encodeURIComponent('s02-压力测试报告.md')
          + '](baton-file:' + 'a'.repeat(32) + '.md)', isAgent: true,
      };
      state.rootSessionId = state.appState.session;
      state.rootSessionPreview = state.appState.sessionPreview;
      state.sessionThreads = [];
      window.updateBreadcrumb();
    }

    await context.test('runtime and Agent capsules follow the title, leaving three header actions', () => {
      for (const runtime of ['codex', 'claude']) {
        showSession(runtime);
        assert.deepEqual([...document.querySelectorAll('#top-right > button')].map(button => button.title), [
          'Git changes', 'Terminal', 'New Session',
        ]);
        const meta = document.querySelector('.session-title-meta');
        assert.ok(meta.previousElementSibling.classList.contains('breadcrumb-title'));
        assert.equal(meta.previousElementSibling.textContent, '这个文档写的是什么 s02-压力测试报告.md');
        assert.deepEqual([...meta.querySelectorAll('.badge')].map(badge => badge.textContent), [
          runtime === 'codex' ? 'Codex' : 'Claude', 'Agent',
        ]);
        assert.equal(getComputedStyle(meta).display, 'inline-flex');
        assert.equal(document.querySelector('#top-right .runtime-mark'), null);
        assert.equal(document.querySelector('.top-logo').outerHTML, brandMarkup);
        assert.equal(document.getElementById('ws-reconnect-indicator'), null);
        state.wsStatusText = 'reconnecting';
        window.updateBreadcrumb();
        assert.equal(document.getElementById('ws-reconnect-indicator')?.nextElementSibling?.title, 'Git changes');
        window.updateBreadcrumb();
        assert.equal(document.querySelectorAll('#ws-reconnect-indicator').length, 1);
        state.wsStatusText = 'connected';
        window.updateBreadcrumb();
        assert.equal(document.getElementById('ws-reconnect-indicator'), null);
      }
    });

    await context.test('capsules fit inline or reveal on expansion, and respond to resizing', async () => {
      showSession();
      document.documentElement.classList.add('native-mobile');
      const nav = document.querySelector('.breadcrumb-nav');
      const meta = nav.querySelector('.session-title-meta');
      let availableWidth = 320;
      Object.defineProperties(nav, {
        clientWidth: { get: () => availableWidth },
        scrollWidth: { get: () => nav.classList.contains('is-truncated') ? 280 : 420 },
      });
      for (const width of [320, 420, 320]) {
        availableWidth = width;
        window.dispatchEvent(new window.Event('resize'));
        await new Promise(resolve => requestAnimationFrame(resolve));
        assert.equal(getComputedStyle(meta).display, width < 420 ? 'none' : 'inline-flex');
      }
      nav.click();
      await new Promise(resolve => requestAnimationFrame(resolve));
      assert.equal(getComputedStyle(meta).display, 'inline-flex');
      nav.click();
      await new Promise(resolve => requestAnimationFrame(resolve));
      assert.equal(getComputedStyle(meta).display, 'none');
      document.documentElement.classList.remove('native-mobile');
    });

    await context.test('the runtime capsule opens agent threads without collapsing the title', () => {
      showSession();
      state.sessionThreads = [
        { sessionId: 'codex:root', status: 'completed' },
        { sessionId: 'codex:child', status: 'running' },
      ];
      window.updateBreadcrumb();
      const nav = document.querySelector('.breadcrumb-nav');
      nav.classList.add('expanded');
      const trigger = nav.querySelector('.agent-thread-trigger');
      assert.equal(trigger.getAttribute('aria-controls'), 'agentThreadsModal');
      assert.ok(trigger.querySelector('.agent-thread-dot.running'));
      let opened = 0;
      const originalOpen = window.openAgentThreadsModal;
      window.openAgentThreadsModal = () => { opened++; };
      try {
        trigger.click();
        assert.equal(opened, 1);
        assert.equal(nav.classList.contains('expanded'), true);
      } finally {
        window.openAgentThreadsModal = originalOpen;
      }
    });

    await context.test('terminal opens from detail and list, but not the new-session composer', async () => {
      showSession();
      for (const session of ['codex:root', null, '__new__']) {
        state.appState.session = session;
        window.updateBreadcrumb();
        const button = document.querySelector('.project-terminal-entry');
        assert.equal(!!button, session !== '__new__');
        if (button) assert.equal(button.getAttribute('onclick'), 'openProjectTerminalPage()');
        const count = window.__terminalOpenCalls.length;
        const opening = window.openProjectTerminalPage();
        assert.equal(window.__terminalOpenCalls.length, count + (session === '__new__' ? 0 : 1));
        await opening;
        assert.equal(state.appState.session, session);
        assert.equal(document.getElementById('content').textContent, 'Existing conversation');
      }
      assert.deepEqual(window.__terminalOpenCalls[0], { device: 'Mac', projectHash: 'project', projectName: 'Project' });
    });

    await context.test('rename is visible by default, opens empty, and updates only after success', async () => {
      showSession('claude');
      const rpc = await vite.ssrLoadModule('/js/ws-rpc.js');
      const nav = document.querySelector('.breadcrumb-nav');
      nav.classList.remove('expanded');
      const button = nav.querySelector('.session-rename-button');
      assert.equal(getComputedStyle(button).display, 'inline-flex');
      button.click();
      assert.equal(nav.classList.contains('expanded'), false);
      const input = document.getElementById('sessionRenameInput');
      const modal = document.getElementById('sessionRenameModal');
      const confirm = modal.querySelector('.confirm');
      assert.equal(input.value, '');
      assert.equal(document.activeElement, input);
      assert.equal(confirm.disabled, true);
      input.value = '  New native title  ';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      let payload;
      window.wsSendReliable = message => { payload = message; };
      confirm.click();
      assert.equal(confirm.disabled, true);
      assert.equal(payload.sessionId, state.rootSessionId);
      assert.equal(payload.name, 'New native title');
      rpc.handleWsRpcMessage({ ...payload, ok: false, error: 'Bridge offline.' });
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(modal.querySelector('.modal-error').textContent, 'Bridge offline.');
      assert.notEqual(state.rootSessionPreview, 'New native title');
      confirm.click();
      rpc.handleWsRpcMessage({ ...payload, ok: true, synced: true });
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(document.getElementById('sessionRenameModal'), null);
      assert.equal(state.rootSessionPreview, 'New native title');
      assert.equal(document.querySelector('.breadcrumb-title').textContent, 'New native title');
      assert.equal(JSON.parse(sessionStorage.getItem('baton-nav')).sessionPreview, 'New native title');
      window.openSessionRename();
      assert.equal(document.getElementById('sessionRenameInput').value, '');
      document.querySelector('#sessionRenameModal .cancel').click();
      state.appState.session = '__new__';
      state.rootSessionId = null;
      window.updateBreadcrumb();
      assert.equal(document.querySelector('.session-rename-button'), null);
    });

    await context.test('isolated native end-to-end rename with real Claude CLI and Codex app-server', {
      skip: process.env.BATON_TEST_NATIVE_RENAME !== '1', timeout: 60000,
    }, async () => {
      const fs = await import('node:fs');
      const os = await import('node:os');
      const { randomUUID } = await import('node:crypto');
      const { handleSessionRename, renameNativeSession } = await import('../../bridge/session-rename.mjs');
      const { CodexAppServerClient } = await import('../../bridge/codex-app-server.mjs');
      const { ClaudePool } = await import('../../bridge/headless.mjs');
      const { getSessionMetadata } = await import('../../bridge/session.mjs');
      const { inspectCodexSession } = await import('../../bridge/codex-session.mjs');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-rename-e2e-'));
      const oldClaudeHome = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
      const claudePool = new ClaudePool({ env: {
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      } });
      const codexHome = path.join(root, 'codex');
      const cwd = path.join(root, 'project');
      const projectHash = cwd.replace(/[^a-zA-Z0-9-]/g, '-');
      const timestamp = new Date().toISOString();
      const claudeId = randomUUID(), codexId = randomUUID();
      const claudeFile = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', projectHash, `${claudeId}.jsonl`);
      const codexFile = path.join(codexHome, 'sessions/2026/09/24', `rollout-2026-09-24T00-00-00-${codexId}.jsonl`);
      let reader;
      try {
        fs.mkdirSync(cwd, { recursive: true });
        for (const file of [claudeFile, codexFile]) fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(claudeFile, JSON.stringify({
          type: 'user', sessionId: claudeId, uuid: randomUUID(), parentUuid: null, cwd, timestamp,
          message: { role: 'user', content: 'Native rename verification' },
        }) + '\n');
        fs.writeFileSync(codexFile, [
          { type: 'session_meta', timestamp, payload: {
            id: codexId, timestamp, cwd, originator: 'codex_cli_rs', cli_version: '0.155.1',
            source: 'cli', model_provider: 'openai', base_instructions: { text: '' },
          } },
          { type: 'event_msg', timestamp, payload: {
            type: 'user_message', message: 'Native rename verification', images: [], local_images: [], text_elements: [],
          } },
        ].map(JSON.stringify).join('\n') + '\n');
        const rpc = await vite.ssrLoadModule('/js/ws-rpc.js');
        const synced = [];
        let operation;
        window.wsSendReliable = message => {
          operation = handleSessionRename({ ...message, replyConnectionId: 'local-app' }, {
            deviceName: 'Mac',
            rename: message => renameNativeSession(message, {
              codexHomes: [codexHome], findClaudeSessionFile: () => claudeFile, claudePool,
            }),
            post: async (endpoint, body) => {
              assert.equal(endpoint, '/api/bridge/session-title');
              synced.push(body);
              return { ok: true };
            },
            send: message => rpc.handleWsRpcMessage(message),
          });
        };
        for (const runtime of ['claude', 'codex']) {
          showSession(runtime);
          const sessionId = runtime === 'claude' ? claudeId : `codex:${codexId}`;
          state.appState.session = state.rootSessionId = state.activeThreadId = sessionId;
          state.appState.project.hash = projectHash;
          window.updateBreadcrumb();
          for (const name of [`${runtime} 原生名称验证`, `${runtime} 再次改名`]) {
            const nav = document.querySelector('.breadcrumb-nav');
            nav.querySelector('.session-rename-button').click();
            const input = document.getElementById('sessionRenameInput');
            assert.equal(input.value, '');
            input.value = name;
            input.dispatchEvent(new window.Event('input', { bubbles: true }));
            document.querySelector('#sessionRenameModal .confirm').click();
            await operation;
            await new Promise(resolve => setTimeout(resolve, 0));
            assert.equal(document.getElementById('sessionRenameModal'), null);
            assert.equal(document.querySelector('.breadcrumb-title').textContent, name);
            assert.equal(synced.at(-1).name, name);
            if (runtime === 'claude') {
              assert.equal(getSessionMetadata(claudeFile).preview, name);
            } else {
              reader = new CodexAppServerClient({ socketPath: false, env: { ...process.env, CODEX_HOME: codexHome } });
              assert.equal((await reader.request('thread/read', { threadId: codexId, includeTurns: false })).thread.name, name);
              assert.equal(inspectCodexSession(codexId, { codexHomes: [codexHome] }).preview, name);
              await reader.stop();
              reader = null;
            }
          }
        }
        assert.equal(synced.length, 4);
      } finally {
        claudePool.shutdownAll();
        await reader?.stop();
        if (oldClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = oldClaudeHome;
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  } finally {
    await vite.close();
    dom.window.close();
  }
});
