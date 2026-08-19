import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const ROOT = path.resolve(import.meta.dirname, '../..');

async function waitFor(predicate) {
  for (var index = 0; index < 100; index++) {
    if (predicate()) return;
    await new Promise(function (resolve) { setTimeout(resolve, 5); });
  }
  throw new Error('Timed out waiting for foreground refresh');
}

test('foreground visibility reuses current navigation loaders or resumes the open session', async () => {
  var visibility = 'visible';
  const dom = new JSDOM(
    '<!doctype html><body>'
      + '<div class="top-bar"><div class="top-left"></div><div id="top-right"></div></div>'
      + '<div id="breadcrumb"></div><div id="content"></div>'
      + '<div id="input-bar"></div><button id="scroll-bottom-btn"></button>'
      + '</body>',
    { url: 'https://baton.test/index.html', pretendToBeVisual: true },
  );
  const window = dom.window;
  const content = window.document.getElementById('content');
  Object.defineProperty(content, 'clientHeight', {
    configurable: true,
    value: 100,
  });
  Object.defineProperty(content, 'scrollHeight', {
    configurable: true,
    value: 1000,
  });
  Object.defineProperty(window.document, 'visibilityState', {
    configurable: true,
    get() { return visibility; },
  });
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    history: window.history,
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    CSS: window.CSS,
    getComputedStyle: window.getComputedStyle,
    requestAnimationFrame: function (callback) { return setTimeout(callback, 0); },
    cancelAnimationFrame: clearTimeout,
  });
  window.requestAnimationFrame = globalThis.requestAnimationFrame;
  window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
  window.__APEEK_TEST__ = true;
  window.__setTopSync = function () {};
  window.loadViewerLibs = function () { return new Promise(function () {}); };

  var projectFetches = 0;
  var sessionFetches = 0;
  var homeFetches = 0;
  async function api(pathname) {
    if (pathname === '/api/bridge/projects') {
      projectFetches++;
      return {
        projects: [{
          projectHash: 'P',
          projectName: 'Project',
          projectPath: '/workspace/P',
          sessionCount: 1,
          runningCount: projectFetches - 1,
          needsInputCount: 0,
          lastActive: '2026-08-18T00:00:00.000Z',
        }],
        hasMore: false,
      };
    }
    if (pathname === '/api/bridge/active-sessions') {
      homeFetches++;
      return { sessions: [], recentSessions: [] };
    }
    if (pathname === '/api/bridge/sessions') {
      sessionFetches++;
      return {
        sessions: [{
          sessionId: 'codex:session-1',
          preview: 'Session',
          lastActive: '2026-08-18T00:00:00.000Z',
          size: 1,
          model: 'test',
          status: sessionFetches === 1 ? 'completed' : 'needs_input',
          agentDetail: sessionFetches === 1 ? '' : 'Approve command',
          runtime: 'codex',
        }],
        hasMore: false,
      };
    }
    if (pathname === '/api/bridge/devices') {
      return {
        devices: [{
          deviceName: 'D',
          online: true,
          projectCount: 1,
          sessionCount: 1,
          runningCount: homeFetches,
          needsInputCount: 0,
          runtimeCapabilities: { claude: { canCreate: true } },
        }],
      };
    }
    throw new Error('Unexpected request: ' + pathname);
  }
  Object.assign(globalThis, {
    api,
    disconnectWs: function () {},
    updateSpinner: function () {},
    skeletonItems: function () { return ''; },
    skeletonMessages: function () { return ''; },
  });
  Object.assign(window, {
    api,
    disconnectWs: globalThis.disconnectWs,
    updateSpinner: globalThis.updateSpinner,
    skeletonItems: globalThis.skeletonItems,
    skeletonMessages: globalThis.skeletonMessages,
  });
  window.__loadHome = async function (active, devices, options) {
    const values = await Promise.all([active, devices]);
    options?.onFresh?.(values[0], values[1]);
    return values;
  };

  const vite = await createServer({
    root: path.join(ROOT, 'web'),
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true },
  });

  try {
    await vite.ssrLoadModule('/js/app.js');
    const { state } = await vite.ssrLoadModule('/js/state.js');
    await window.loadProjects('D');
    content.scrollTop = 75;

    visibility = 'hidden';
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    visibility = 'visible';
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    await waitFor(function () { return projectFetches === 2; });
    assert.match(content.textContent, /1 running/);
    assert.equal(content.scrollTop, 0);

    await window.loadSessions('D', 'P', 'Project');
    assert.match(content.textContent, /Done/);
    visibility = 'hidden';
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    visibility = 'visible';
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    await waitFor(function () { return sessionFetches === 2; });
    assert.match(content.textContent, /Needs input/);
    assert.match(content.textContent, /Approve command/);

    await window.loadDevices();
    const firstHomeFetches = homeFetches;
    visibility = 'hidden';
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    visibility = 'visible';
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    await waitFor(function () { return homeFetches === firstHomeFetches + 1; });

    var resumes = 0;
    window.resumeSessionForeground = function () { resumes++; };
    state.appState = {
      device: 'D',
      project: { hash: 'P', name: 'Project' },
      session: 'codex:session-1',
    };
    visibility = 'hidden';
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    visibility = 'visible';
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    await waitFor(function () { return resumes === 1; });
  } finally {
    await vite.close();
    dom.window.close();
  }
});
