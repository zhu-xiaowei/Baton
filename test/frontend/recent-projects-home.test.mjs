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
      win.__apiReady = Promise.resolve();
      win.api = async path => { const r = await win.fetch(new URL(path, win.location.href).href); if (!r.ok) throw new Error(String(r.status)); return r.json(); };
      win.bridgeHome = (p) => win.api('/api/bridge/active-sessions', p); win.bridgeDevices = () => win.api('/api/bridge/devices'); win.bridgeList = (m, p) => win.api('/api/bridge/' + (m === 'threads' ? 'session-threads' : m), p); win.bridgeHistory = (p, o) => win.api('/api/bridge/messages', p, o);
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

test('Show more is disabled while home loads, then reveals the loaded projects without a request', async () => {
  const page = { ...active, hasMoreProjects: false, recentProjects: Array.from({ length: 7 }, (_, i) => ({
    ...project, projectName: 'Project ' + i, projectHash: 'project-' + i })) };
  let answer;
  const h = harness({ cache: { active: page, devices }, fetchData: url => url.includes('active-sessions')
    ? new Promise(resolve => { answer = () => resolve({ ok: true, json: async () => page }); })
    : { ok: true, json: async () => devices } });
  try {
    await waitFor(() => answer && h.doc.querySelector('[data-show-more-projects]'));
    assert.equal(h.doc.querySelector('[data-show-more-projects]').disabled, true);
    answer();
    await waitFor(() => !h.doc.querySelector('[data-show-more-projects]').disabled);
    h.doc.querySelector('[data-show-more-projects]').click();
    assert.equal(h.doc.querySelectorAll('.recent-project').length, 7);
    h.doc.querySelector('[data-show-more-projects]').click();
    assert.equal(h.doc.querySelectorAll('.recent-project').length, 5);
    assert.equal(h.requests.length, 2);
  } finally { h.win.close(); }
});
