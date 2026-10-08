import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
const filename = 's02-压力测试报告.md';
const prompt = 'Inspect "quoted" <script> & session';
const preview = prompt + ' [' + encodeURIComponent(filename)
  + '](</Users/demo/.baton-bridge/attachments/' + 'a'.repeat(32) + '.md>)';
const displayPreview = prompt + ' ' + filename;
const session = {
  sessionId: 'codex:session/one', preview, status: 'needs_input',
  lastActive: '2026-09-17T02:00:00.000Z', isAgent: true,
  agentName: 'Review <agent>', agentDetail: 'Choose "keep" or "remove"',
};
const project = {
  deviceName: 'Mac & one', projectHash: '-workspace/project #1',
  projectName: 'repo <one>', sessions: [session],
};
const devices = { devices: [
  { deviceName: project.deviceName, deviceDisplayName: 'Office Mac', online: true },
  { deviceName: 'Linux', deviceDisplayName: 'Dev EC2', online: false },
] };
const active = {
  sessions: [{ ...session, deviceName: project.deviceName, projectHash: project.projectHash, projectName: project.projectName }],
  recentSessions: [{ ...session, preview: 'Legacy completed card' }],
  recentProjects: [project, {
    ...project, deviceName: 'Linux',
    sessions: [{ ...session, sessionId: 'claude-session', isAgent: false, status: 'completed' }],
  }],
};

async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for home');
}

function harness({ cache, fetchData, nativeMobile = false } = {}) {
  const requests = [];
  const page = nativeMobile
    ? html.replace('<script src="/native-mobile.js"></script>',
      '<script>document.documentElement.classList.add("native-mobile")</script>')
    : html;
  const dom = new JSDOM(page, {
    url: 'http://baton.test/index.html', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(win) {
      win.localStorage.setItem('_ak', win.btoa('fixture-key'));
      if (cache) win.localStorage.setItem('apeek_home_cache', JSON.stringify(cache));
      win.fetch = async url => {
        requests.push(new URL(url).pathname);
        if (fetchData) return fetchData(url);
        return { ok: true, json: async () => url.includes('active-sessions') ? active : devices };
      };
    },
  });
  return { dom, win: dom.window, doc: dom.window.document, requests };
}

test('native mobile startup shows cached home content before refresh completes', async () => {
  const pending = new Promise(() => {});
  const h = harness({
    cache: { active, devices },
    fetchData: () => pending,
    nativeMobile: true,
  });
  try {
    await waitFor(() => h.doc.querySelector('#content > *'));
    assert.ok(h.doc.querySelector('#recent-projects-section'));
    assert.equal(h.doc.querySelector('.skeleton-card'), null);
    assert.equal(h.win.__inlineRendered, true);
  } finally { h.win.close(); }
});

test('native mobile startup shows a skeleton while uncached refresh is pending', async () => {
  const pending = new Promise(() => {});
  const h = harness({ fetchData: () => pending, nativeMobile: true });
  try {
    await waitFor(() => h.doc.querySelector('#content > *'));
    assert.ok(h.doc.querySelector('.skeleton-card'));
    assert.equal(h.doc.querySelector('#recent-projects-section'), null);
  } finally { h.win.close(); }
});

test('home consumes recentProjects from the existing two requests and keeps active cards and devices', async () => {
  const h = harness();
  try {
    await waitFor(() => h.doc.querySelectorAll('.recent-project').length === 2);
    assert.deepEqual(h.requests, ['/api/bridge/active-sessions', '/api/bridge/devices']);
    assert.equal(h.doc.querySelectorAll('#active-section .active-card').length, 1);
    assert.equal(h.doc.querySelectorAll('#devices-section .device-item').length, 2);
    assert.equal(h.doc.querySelector('#recent-agents-section'), null);
    assert.doesNotMatch(h.doc.getElementById('content').textContent, /Legacy completed card|Completed Sessions/);
    assert.deepEqual([...h.doc.querySelectorAll('.recent-project-device')].map(el => el.textContent), ['Office Mac', 'Dev EC2']);
    assert.deepEqual([...h.doc.querySelectorAll('.recent-session-status')].map(el => el.textContent), ['Needs input', 'Done']);
    assert.deepEqual([...h.doc.querySelectorAll('.recent-session .runtime-mark')].map(el => el.getAttribute('aria-label')), ['Codex', 'Claude Code']);
    assert.deepEqual([...h.doc.querySelectorAll('.recent-session-title')].map(el => el.textContent), [session.agentName, displayPreview]);
    assert.equal(h.doc.querySelector('.recent-project-name').textContent, project.projectName);
    assert.equal(h.doc.querySelector('#recent-projects-section script'), null);
    assert.deepEqual([...h.doc.querySelectorAll('.recent-session')].map(el => el.title), [session.agentName + '\n' + session.agentDetail, displayPreview]);
    assert.equal(h.doc.querySelector('#active-section').compareDocumentPosition(h.doc.querySelector('#recent-projects-section')) & 4, 4);
    assert.equal(h.doc.querySelector('#recent-projects-section').compareDocumentPosition(h.doc.querySelector('#devices-section')) & 4, 4);
  } finally { h.win.close(); }
});

test('project and session links keep identity, preserve modified clicks, and reuse existing navigation', async () => {
  const h = harness();
  try {
    await waitFor(() => h.doc.querySelector('.recent-session'));
    const opened = [];
    h.win.loadProjects = () => {};
    h.win.loadSessions = (...args) => opened.push(args);
    h.win.openActiveSession = el => opened.push({ ...el.dataset });
    const projectLink = h.doc.querySelector('.recent-project-link');
    const row = h.doc.querySelector('.recent-session');
    const href = '#/' + encodeURIComponent(project.deviceName) + '/' + encodeURIComponent(project.projectHash);
    assert.equal(projectLink.getAttribute('href'), href);
    assert.equal(row.getAttribute('href'), href + '/' + encodeURIComponent(session.sessionId));
    const modified = new h.win.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    row.dispatchEvent(modified);
    assert.equal(modified.defaultPrevented, false);
    assert.equal(opened.length, 0);
    projectLink.click();
    assert.deepEqual(opened.shift(), [project.deviceName, project.projectHash, project.projectName]);
    row.click();
    const data = opened.shift();
    assert.equal(data.device, project.deviceName);
    assert.equal(data.phash, project.projectHash);
    assert.equal(data.sid, session.sessionId);
    assert.equal(data.preview, preview);
    assert.equal(data.isagent, 'true');
    assert.equal(h.requests.length, 2, 'rendering and navigation delegation add no project fetch');
  } finally { h.win.close(); }
});

test('cached projects remain usable when refreshing the home data fails', async () => {
  let reject;
  const pending = new Promise((_, fail) => { reject = fail; });
  const h = harness({
    cache: { active, devices },
    fetchData: () => pending,
  });
  try {
    await waitFor(() => h.doc.querySelector('.recent-project'));
    reject(new Error('offline'));
    await h.win.__homeLoadPromise;
    assert.equal(h.doc.querySelectorAll('.recent-project').length, 2);
    assert.equal(h.doc.querySelector('.recent-session').dataset.preview, preview);
    assert.equal(h.doc.querySelectorAll('.recent-session-title')[1].textContent, displayPreview);
  } finally { h.win.close(); }
});

test('returning from a session restores the home frame and position before refreshing', async () => {
  const h = harness();
  try {
    await waitFor(() => h.doc.querySelector('.recent-project-toggle'));
    await h.win.__homeLoadPromise;
    const content = h.doc.getElementById('content');
    h.doc.querySelector('.recent-project-toggle').click();
    const snapshot = {
      topBarHtml: h.doc.querySelector('.top-bar').innerHTML,
      breadcrumbHtml: '', breadcrumbDisplay: 'none',
      contentHtml: content.innerHTML, scrollTop: 640,
    };
    content.innerHTML = '<div>Session detail</div>';
    content.scrollTop = 0;
    let resolveFresh;
    const pending = new Promise(resolve => { resolveFresh = resolve; });
    const loading = h.win.__loadHome(pending, Promise.resolve(devices), {
      restoreSnapshot: snapshot, resetScroll: false,
    });
    assert.equal(content.scrollTop, 640);
    assert.equal(h.doc.querySelector('.recent-project-toggle').getAttribute('aria-expanded'), 'false');
    const fresh = { ...active, recentProjects: active.recentProjects.map(project => ({ ...project, projectName: 'Updated project' })) };
    resolveFresh(fresh);
    await loading;
    assert.equal(content.scrollTop, 640);
    assert.equal(h.doc.querySelector('.recent-project-name').textContent, 'Updated project');
    assert.equal(h.doc.querySelector('.recent-project-toggle').getAttribute('aria-expanded'), 'false');
    h.doc.querySelector('.recent-project-toggle').click();
    assert.equal(h.doc.querySelector('.recent-project-toggle').getAttribute('aria-expanded'), 'true');
    await h.win.__loadHome(Promise.resolve(fresh), Promise.resolve(devices), { resetScroll: true });
    assert.equal(content.scrollTop, 0);
  } finally { h.win.close(); }
});

test('an empty project snapshot has a quiet empty state without hiding devices', async () => {
  const h = harness({
    fetchData: async url => ({
      ok: true,
      json: async () => url.includes('active-sessions') ? { sessions: [], recentSessions: [], recentProjects: [] } : devices,
    }),
  });
  try {
    await waitFor(() => h.doc.querySelector('.recent-projects-empty'));
    assert.equal(h.doc.querySelectorAll('.recent-project').length, 0);
    assert.equal(h.doc.querySelectorAll('#devices-section .device-item').length, 2);
  } finally { h.win.close(); }
});

test('recent projects account for the active list spacing only when active sessions are present', async () => {
  const h = harness();
  try {
    const style = h.doc.createElement('style');
    style.textContent = readFileSync(new URL('../../web/css/style.css', import.meta.url), 'utf8');
    h.doc.head.appendChild(style);
    await h.win.__homeLoadPromise;
    assert.equal(h.win.getComputedStyle(h.doc.querySelector('.recent-projects-toggle')).paddingTop, '8px');

    await h.win.__loadHome(Promise.resolve({ ...active, sessions: [] }), Promise.resolve(devices));
    const content = h.doc.getElementById('content');
    assert.equal(content.firstElementChild.id, 'recent-projects-section');
    assert.equal(h.win.getComputedStyle(h.doc.querySelector('.recent-projects-toggle')).paddingTop, '16px');
    assert.equal(h.win.getComputedStyle(h.doc.querySelector('.devices-toggle')).minHeight, '0px');

    const edgePreview = content.cloneNode(true);
    edgePreview.removeAttribute('id');
    edgePreview.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
    h.doc.body.appendChild(edgePreview);
    assert.equal(h.win.getComputedStyle(edgePreview.querySelector('.recent-projects-toggle')).paddingTop, '16px');
    edgePreview.remove();

    await h.win.__loadHome(Promise.resolve(active), Promise.resolve(devices));
    assert.equal(h.win.getComputedStyle(h.doc.querySelector('.recent-projects-toggle')).paddingTop, '8px');
  } finally { h.win.close(); }
});

test('section and project collapse independently; View all never toggles the project', async () => {
  const h = harness();
  try {
    await waitFor(() => h.doc.querySelector('button.recent-project-toggle'));
    const sectionToggle = h.doc.querySelector('.recent-projects-toggle');
    const projectToggle = h.doc.querySelector('.recent-project-toggle');
    const list = h.doc.getElementById(sectionToggle.getAttribute('aria-controls'));
    const panel = h.doc.getElementById(projectToggle.getAttribute('aria-controls'));
    const otherPanel = h.doc.querySelectorAll('.recent-project-sessions')[1];
    assert.equal(sectionToggle.getAttribute('aria-expanded'), 'true');
    assert.equal(projectToggle.getAttribute('aria-expanded'), 'true');
    assert.equal(list.hidden, false);
    assert.equal(panel.hidden, false);
    const opened = [];
    h.win.loadProjects = () => {};
    h.win.loadSessions = (...args) => opened.push(args);
    projectToggle.click();
    assert.equal(panel.hidden, true);
    assert.equal(projectToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(otherPanel.hidden, false);
    assert.equal(opened.length, 0);
    sectionToggle.click();
    assert.equal(list.hidden, true);
    sectionToggle.click();
    assert.equal(list.hidden, false);
    assert.equal(panel.hidden, true, 'opening the section preserves each project state');
    const link = h.doc.querySelector('.recent-project-link');
    assert.equal(link.closest('button'), null);
    link.click();
    assert.deepEqual(opened, [[project.deviceName, project.projectHash, project.projectName]]);
    assert.equal(panel.hidden, true, 'View all does not expand the project');
    projectToggle.click();
    assert.equal(panel.hidden, false);
    assert.equal(h.requests.length, 2, 'folding never queries the backend');
  } finally { h.win.close(); }
});

test('a home refresh preserves folds by device and project when project order changes', async () => {
  const h = harness();
  try {
    await waitFor(() => h.doc.querySelector('button.recent-project-toggle'));
    await h.win.__homeLoadPromise;
    h.doc.querySelector('.recent-project-toggle').click();
    h.doc.querySelector('.recent-projects-toggle').click();
    const fresh = { ...active, recentProjects: [...active.recentProjects].reverse() };
    await h.win.__loadHome(Promise.resolve(fresh), Promise.resolve(devices));
    assert.equal(h.doc.getElementById('recent-project-list').hidden, true);
    const toggles = [...h.doc.querySelectorAll('.recent-project-toggle')];
    assert.deepEqual(toggles.map(el => el.getAttribute('aria-expanded')), ['true', 'false']);
    assert.deepEqual([...h.doc.querySelectorAll('.recent-project-sessions')].map(el => el.hidden), [false, true]);
  } finally { h.win.close(); }
});

test('device cards navigate while the Devices section folds independently and stays folded on refresh', async () => {
  const h = harness();
  try {
    await waitFor(() => h.doc.querySelector('.devices-toggle'));
    await h.win.__homeLoadPromise;
    const toggle = h.doc.querySelector('.devices-toggle');
    const panel = h.doc.getElementById('devices-section');
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(panel.hidden, false);
    const opened = [];
    h.win.loadProjects = device => opened.push(device);
    const card = panel.querySelector('a.device-card');
    assert.equal(card.getAttribute('href'), '#/' + encodeURIComponent(project.deviceName));
    card.click();
    assert.deepEqual(opened, [project.deviceName]);
    toggle.click();
    assert.equal(panel.hidden, true);
    assert.equal(h.doc.getElementById('recent-project-list').hidden, false);
    await h.win.__loadHome(Promise.resolve(active), Promise.resolve({
      devices: devices.devices.map(d => ({ ...d, runningCount: 2 })),
    }));
    assert.equal(h.doc.getElementById('devices-section').hidden, true);
    h.doc.querySelector('.devices-toggle').click();
    assert.equal(h.doc.getElementById('devices-section').hidden, false);
    assert.equal(h.requests.length, 2);
  } finally { h.win.close(); }
});

function projectPage(count, hasMoreProjects) {
  return {
    ...active, hasMoreProjects,
    recentProjects: Array.from({ length: count }, (_, i) => ({
      ...project, projectName: 'Project ' + i, projectHash: 'project-' + i,
    })),
  };
}

function pageHarness(first) {
  return harness({
    fetchData: async url => ({
      ok: true, json: async () => url.includes('active-sessions') ? first : devices,
    }),
  });
}

test('Show more appends unseen projects without replacing existing projects, sessions, or active cards', async () => {
  const first = projectPage(5, true);
  const complete = projectPage(8, false);
  complete.recentProjects.reverse();
  complete.recentProjects = complete.recentProjects.map(p => ({
    ...p, sessions: p.sessions.map(s => ({ ...s, preview: 'Updated session preview' })),
  }));
  complete.sessions = [{ ...first.sessions[0], isAgent: false, preview: 'Updated active session' }];
  const h = pageHarness(first);
  try {
    await waitFor(() => h.doc.querySelector('[data-show-more-projects]'));
    const calls = [];
    let answer;
    h.win.api = (path, params) => {
      calls.push([path, { ...params }]);
      return new Promise(resolve => { answer = resolve; });
    };
    const original = h.doc.querySelector('.recent-project');
    const originalProjects = [...h.doc.querySelectorAll('.recent-project')];
    const originalSession = h.doc.querySelector('.recent-session');
    const activeSection = h.doc.getElementById('active-section');
    const activeHtml = activeSection.innerHTML;
    const devicesSection = h.doc.getElementById('devices-section');
    const foldKey = h.doc.querySelector('.recent-project-toggle').dataset.homeToggle;
    h.doc.querySelector('.recent-project-toggle').click();
    const button = h.doc.querySelector('[data-show-more-projects]');
    assert.equal(button.textContent, 'Show more');
    button.click();
    const run = h.win.__homeLoadPromise;
    await waitFor(() => answer);
    assert.deepEqual(calls, [['/api/bridge/active-sessions', { allProjects: true }]]);
    assert.equal(h.doc.querySelector('[data-show-more-projects]'), button);
    assert.equal(button.textContent, 'Loading…');
    assert.equal(button.disabled, true);
    assert.equal(button.getAttribute('aria-busy'), 'true');
    button.click();
    assert.equal(calls.length, 1, 'loading cannot start a duplicate request');
    assert.ok(h.doc.querySelector('.recent-projects-loading'));
    assert.equal(h.doc.querySelector('.recent-project'), original);
    answer(complete);
    await run;
    assert.equal(h.doc.querySelectorAll('.recent-project').length, 8);
    originalProjects.forEach((node, i) => assert.equal(h.doc.querySelectorAll('.recent-project')[i], node));
    assert.equal(h.doc.querySelector('.recent-session'), originalSession);
    assert.equal(originalSession.dataset.preview, preview);
    assert.equal(h.doc.getElementById('active-section'), activeSection);
    assert.equal(activeSection.innerHTML, activeHtml);
    assert.equal(h.doc.getElementById('devices-section'), devicesSection);
    assert.deepEqual([...h.doc.querySelectorAll('.recent-project-name')].map(el => el.textContent),
      ['Project 0', 'Project 1', 'Project 2', 'Project 3', 'Project 4', 'Project 7', 'Project 6', 'Project 5']);
    assert.equal(h.doc.getElementById('recent-projects-footer'), null);
    const folded = [...h.doc.querySelectorAll('.recent-project-toggle')].find(el => el.dataset.homeToggle === foldKey);
    assert.equal(folded.getAttribute('aria-expanded'), 'false');
    assert.deepEqual({ ...h.win.__homeActiveParams() }, { allProjects: true });
    const cached = JSON.parse(h.win.localStorage.getItem('apeek_home_cache')).active;
    assert.equal(cached.recentProjects.length, 8);
    assert.deepEqual(cached.sessions, first.sessions);
    assert.deepEqual(cached.recentSessions, first.recentSessions);
    assert.deepEqual(cached.recentProjects.slice(0, 5), first.recentProjects);
    assert.deepEqual(h.requests, ['/api/bridge/active-sessions', '/api/bridge/devices']);
    await h.win.__loadHome(Promise.resolve(complete), Promise.resolve(devices));
    assert.equal(h.doc.querySelector('.recent-project-name').textContent, 'Project 7',
      'a normal refresh still applies the latest ordering');
    assert.match(h.doc.getElementById('active-section').textContent, /Updated active session/);
  } finally { h.win.close(); }
});

test('a failed Show more keeps the five projects and restores an unnumbered retry button', async () => {
  const h = pageHarness(projectPage(5, true));
  try {
    await waitFor(() => h.doc.querySelector('[data-show-more-projects]'));
    h.win.api = async () => { throw new Error('offline'); };
    h.doc.querySelector('[data-show-more-projects]').click();
    await h.win.__homeLoadPromise;
    assert.equal(h.doc.querySelectorAll('.recent-project').length, 5);
    assert.equal(h.doc.querySelector('[data-show-more-projects]').textContent, 'Show more');
    assert.ok(h.doc.querySelector('.recent-projects-error'));
    assert.equal(h.win.__homeActiveParams(), undefined);
    h.win.api = async () => projectPage(7, false);
    h.doc.querySelector('[data-show-more-projects]').click();
    await h.win.__homeLoadPromise;
    assert.equal(h.doc.querySelectorAll('.recent-project').length, 7);
    assert.equal(h.doc.getElementById('recent-projects-footer'), null);
  } finally { h.win.close(); }
});

test('a late default home response cannot replace the expanded snapshot or its cache', async () => {
  const first = projectPage(5, true);
  const answers = [];
  const h = harness({
    cache: { active: first, devices },
    fetchData: url => new Promise(resolve => answers.push(() => resolve({
      ok: true, json: async () => url.includes('active-sessions') ? first : devices,
    }))),
  });
  try {
    const initialRun = h.win.__homeLoadPromise;
    await waitFor(() => h.doc.querySelector('[data-show-more-projects]'));
    h.win.api = async () => projectPage(8, false);
    h.doc.querySelector('[data-show-more-projects]').click();
    await h.win.__homeLoadPromise;
    answers.forEach(answer => answer());
    await initialRun;
    assert.equal(h.doc.querySelectorAll('.recent-project').length, 8);
    assert.equal(JSON.parse(h.win.localStorage.getItem('apeek_home_cache')).active.recentProjects.length, 8);
  } finally { h.win.close(); }
});

test('Show more does not overwrite a page opened while the request was pending', async () => {
  const first = projectPage(5, true);
  const h = pageHarness(first);
  try {
    await waitFor(() => h.doc.querySelector('[data-show-more-projects]'));
    await h.win.__homeLoadPromise;
    let answer;
    h.win.api = () => new Promise(resolve => { answer = resolve; });
    h.doc.querySelector('[data-show-more-projects]').click();
    const run = h.win.__homeLoadPromise;
    await waitFor(() => answer);
    h.doc.getElementById('content').innerHTML = '<div id="session-view">Session content</div>';
    answer(projectPage(8, false));
    await run;
    assert.equal(h.doc.getElementById('session-view').textContent, 'Session content');
    assert.equal(JSON.parse(h.win.localStorage.getItem('apeek_home_cache')).active.recentProjects.length, 5);
  } finally { h.win.close(); }
});

test('Show more deduplicates by device and project and adds no more than ten projects', async () => {
  const h = pageHarness(projectPage(5, true));
  try {
    await waitFor(() => h.doc.querySelector('[data-show-more-projects]'));
    const expanded = projectPage(15, false);
    expanded.recentProjects[0] = { ...expanded.recentProjects[0], deviceName: 'Linux' };
    h.win.api = async () => expanded;
    h.doc.querySelector('[data-show-more-projects]').click();
    await h.win.__homeLoadPromise;
    const links = [...h.doc.querySelectorAll('.recent-project-link')];
    const keys = links.map(el => JSON.stringify([el.dataset.device, el.dataset.phash]));
    assert.equal(links.length, 15);
    assert.equal(new Set(keys).size, 15);
    assert.equal(links[5].dataset.device, 'Linux');
    assert.equal(links[5].dataset.phash, 'project-0');
    assert.equal(links[14].dataset.phash, 'project-13');
    const ids = [...h.doc.querySelectorAll('#recent-project-list [id]')].map(el => el.id);
    assert.equal(new Set(ids).size, ids.length, 'appended groups have unique control IDs');
    const opened = [];
    h.win.loadProjects = () => {};
    h.win.loadSessions = (...args) => opened.push(args);
    links[5].click();
    assert.deepEqual(opened, [['Linux', 'project-0', 'Project 0']]);
  } finally { h.win.close(); }
});

test('a cached expanded snapshot still starts at five and appends from the visible five', async () => {
  const complete = projectPage(15, false);
  const h = harness({
    cache: { active: complete, devices },
    fetchData: () => new Promise(() => {}),
  });
  try {
    await waitFor(() => h.doc.querySelector('[data-show-more-projects]'));
    assert.equal(h.doc.querySelectorAll('.recent-project').length, 5);
    h.win.api = async () => complete;
    h.doc.querySelector('[data-show-more-projects]').click();
    await h.win.__homeLoadPromise;
    assert.equal(h.doc.querySelectorAll('.recent-project').length, 15);
    assert.equal(h.doc.getElementById('recent-projects-footer'), null);
  } finally { h.win.close(); }
});

for (const outcome of ['success', 'failure']) {
  test(`a superseded Show more ${outcome} cannot leave a failed refresh stuck or clear a newer loading state`, async () => {
    const h = pageHarness(projectPage(5, true));
    try {
      await waitFor(() => h.doc.querySelector('[data-show-more-projects]'));
      await h.win.__homeLoadPromise;
      const requests = [];
      h.win.api = () => new Promise((resolve, reject) => requests.push({ resolve, reject }));
      h.doc.querySelector('[data-show-more-projects]').click();
      const firstRun = h.win.__homeLoadPromise;
      await waitFor(() => requests.length === 1);

      // Enter a project and return: the new home load owns the visible controls,
      // even if its refresh fails while the original Show more is still pending.
      h.doc.getElementById('content').innerHTML = '<div id="session-view">Session</div>';
      await h.win.__loadHome(Promise.reject(new Error('refresh offline')), Promise.resolve(devices));
      const retry = h.doc.querySelector('[data-show-more-projects]');
      assert.equal(retry.textContent, 'Show more');
      assert.equal(retry.disabled, false);
      assert.equal(retry.hasAttribute('aria-busy'), false);

      retry.click();
      const retryRun = h.win.__homeLoadPromise;
      await waitFor(() => requests.length === 2);
      if (outcome === 'success') requests[0].resolve(projectPage(15, false));
      else requests[0].reject(new Error('old request failed'));
      await firstRun;
      assert.equal(h.win.__homeLoadPromise, retryRun);
      assert.equal(h.doc.querySelectorAll('.recent-project').length, 5);
      assert.equal(retry.textContent, 'Loading…');
      assert.equal(retry.disabled, true);
      assert.equal(h.doc.querySelector('.recent-projects-error'), null);
      // Check the request guard as well as the disabled visual state.
      retry.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(requests.length, 2, 'an old completion must not unlock a duplicate Show more');

      requests[1].resolve(projectPage(7, false));
      await retryRun;
      assert.equal(h.doc.querySelectorAll('.recent-project').length, 7);
      assert.equal(h.doc.querySelector('[data-show-more-projects]'), null);
      assert.deepEqual({ ...h.win.__homeActiveParams() }, { allProjects: true });
      assert.equal(JSON.parse(h.win.localStorage.getItem('apeek_home_cache')).active.recentProjects.length, 7);
    } finally { h.win.close(); }
  });
}
