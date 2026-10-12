import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { createTestServer } from '../frontend/helpers/vite.mjs';
import { handleProjectFilesMessage } from '../../bridge/project/files.mjs';
import { createProjectDirectory } from '../../bridge/project-path.mjs';

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'baton-new-project-'));
const home = path.join(fixture, 'home');
const external = path.join(fixture, 'external');
const artifacts = path.resolve('.test-runs/new-project-' + Date.now());
await fs.mkdir(path.join(home, 'asset', 'nested'), { recursive: true });
for (const name of ['account-dev', 'auto', 'aws', 'zebra', '.private']) {
  await fs.mkdir(path.join(home, 'asset', name));
}
await fs.mkdir(path.join(home, '.hidden'));
await fs.mkdir(external);
await fs.writeFile(path.join(home, 'not-a-folder.txt'), 'file');
await fs.mkdir(artifacts, { recursive: true });
const results = [];
const errors = [];
const creations = [];
const directoryRequests = [];
let chrome, socket, server;
let diagnose;
let offline = false;
let rejectCreate = false;
let heldPath = null;
let releaseHeld;
let holdAsset = true;
let releaseAsset;
const sockets = new WebSocketServer({ noServer: true });
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function waitFor(read) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await read()) return;
    await pause(40);
  }
  throw new Error('Timed out waiting for browser state');
}

try {
  server = await createTestServer({
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    plugins: [{
      name: 'new-project-fixture',
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (!request.url.startsWith('/api/bridge/')) return next();
          const route = new URL(request.url, 'http://test').pathname;
          let body = { projects: [], sessions: [], threads: [], recentProjects: [] };
          if (route.endsWith('/devices')) body = { devices: [{ deviceName: 'Browser', online: true, os: 'linux' }] };
          if (route.endsWith('/config')) body = { wsUrl: 'ws://' + request.headers.host + '/__project_ws' };
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify(body));
        });
        vite.httpServer.on('upgrade', (request, connection, head) => {
          if (!request.url.startsWith('/__project_ws')) return;
          sockets.handleUpgrade(request, connection, head, ws => sockets.emit('connection', ws));
        });
      },
    }],
  });
  sockets.on('connection', ws => {
    ws.on('message', async raw => {
      const message = JSON.parse(raw);
      const send = reply => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply)); };
      if (message.action === 'project_files') {
        if (message.operation === 'browse') directoryRequests.push(message.path);
        if (message.path === path.join(home, 'asset') && holdAsset) {
          await new Promise(resolve => { releaseAsset = resolve; });
        }
        if (message.path === heldPath) await new Promise(resolve => { releaseHeld = resolve; });
        if (offline) send({ ...message, ok: false, error: 'Bridge offline' });
        else await handleProjectFilesMessage(message, { homeDir: home, send });
      }
      if (message.action === 'create_project') {
        if (rejectCreate) {
          send({ action: 'create_project_result', projectPath: message.projectPath, ok: false, error: 'Permission denied' });
        } else {
          const created = createProjectDirectory(message.projectPath, home);
          creations.push(created);
          send({ ...created, action: 'create_project_result', projectPath: message.projectPath, ok: true });
        }
      }
    });
  });
  await server.listen();
  const origin = 'http://127.0.0.1:' + server.httpServer.address().port;
  const profile = path.join(fixture, 'chrome-profile');
  chrome = spawn(process.env.CHROME_BIN
    || (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : 'chromium'), [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-port=0',
    '--user-data-dir=' + profile, '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore' });
  chrome.on('error', error => errors.push(error.message));
  let port;
  await waitFor(async () => {
    try { port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return port; }
    catch { return false; }
  });
  let browserTarget;
  await waitFor(async () => {
    const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    browserTarget = pages.find(page => page.type === 'page');
    return browserTarget;
  });
  socket = new WebSocket(browserTarget.webSocketDebuggerUrl);
  await new Promise(resolve => socket.once('open', resolve));
  let sequence = 0;
  const pending = new Map();
  socket.on('message', raw => {
    const packet = JSON.parse(raw);
    if (packet.id) {
      const command = pending.get(packet.id);
      pending.delete(packet.id);
      if (packet.error) command.reject(new Error(JSON.stringify(packet.error)));
      else command.resolve(packet.result);
    } else if (packet.method === 'Runtime.exceptionThrown') errors.push(packet.params.exceptionDetails);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const click = async selector => {
    const point = await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.scrollIntoView({block:'nearest'});const r=node.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  };
  const typePath = async value => {
    await click('#newProjectInput');
    await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await call('Input.insertText', { text: value });
  };
  const ready = () => evaluate('!document.querySelector("#newProjectModal .confirm").disabled');
  const screenshot = async name => {
    const result = await call('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(artifacts, name + '.png'), Buffer.from(result.data, 'base64'));
  };
  diagnose = async () => {
    console.error(JSON.stringify({
      results, errors,
      page: await evaluate('({path:document.getElementById("newProjectInput")?.value,error:document.getElementById("newProjectError")?.textContent,body:document.body.innerText.slice(-1500)})'),
    }, null, 2));
    await screenshot('failure');
  };
  await call('Runtime.enable');
  await call('Page.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('_ak',btoa('browser-test'));localStorage.setItem('_as',location.origin);sessionStorage.clear();`,
  });
  await call('Page.navigate', { url: origin + '/#/Browser' });
  await waitFor(() => evaluate('typeof createNewProject==="function" && !!document.querySelector("[title=\\"New Project\\"]")'));
  heldPath = '';
  await click('[title="New Project"]');
  await waitFor(() => !!releaseHeld);
  assert.equal(await evaluate('newProjectInput.value'), '~');
  releaseHeld();
  releaseHeld = null;
  heldPath = null;
  await waitFor(ready);
  assert.equal(await evaluate('newProjectInput.value'), home);
  assert.equal(await evaluate('document.querySelector("#newProjectModal .modal-title").textContent'), 'Project folder');
  assert.equal(await evaluate('!!document.querySelector("#newProjectModal .modal-desc")'), false);
  assert.deepEqual(await evaluate('[...document.querySelectorAll("#newProjectDirectories .project-file-name")].map(n=>n.textContent)'), ['asset', '.hidden']);
  await screenshot('desktop-home');
  results.push('Default home, hidden directories, files filtered out');

  await waitFor(() => !!releaseAsset);
  await click('#newProjectDirectories button:first-child');
  assert.equal(await evaluate('newProjectInput.value'), path.join(home, 'asset'));
  assert.equal(await ready(), false);
  await screenshot('folder-loading');
  holdAsset = false;
  releaseAsset();
  releaseAsset = null;
  await waitFor(ready);
  assert.equal(await evaluate('newProjectInput.value'), path.join(home, 'asset'));
  assert.equal(directoryRequests.filter(value => value === path.join(home, 'asset')).length, 1);
  await typePath(path.join(home, 'asset', 'a'));
  await waitFor(ready);
  assert.deepEqual(await evaluate('[...document.querySelectorAll("#newProjectDirectories .project-file-name")].map(n=>n.textContent)'), ['account-dev', 'auto', 'aws']);
  await screenshot('prefix-filter');
  results.push('Typing a filters to account-dev, auto, aws; ordinary folders precede hidden folders');
  await typePath(path.join(home, 'asset') + '/');
  await waitFor(ready);
  assert.deepEqual(await evaluate('[...document.querySelectorAll("#newProjectDirectories .project-file-name")].map(n=>n.textContent)'), ['account-dev', 'auto', 'aws', 'nested', 'zebra', '.private']);
  await evaluate('[...document.querySelectorAll("#newProjectDirectories button")].find(node=>node.textContent==="nested").click()');
  await waitFor(ready);
  assert.equal(await evaluate('newProjectInput.value'), path.join(home, 'asset', 'nested'));
  assert.match(await evaluate('newProjectDirectories.textContent'), /No folders/);
  const beforeParent = directoryRequests.filter(value => value === path.join(home, 'asset')).length;
  await click('#newProjectUp');
  await waitFor(ready);
  assert.equal(await evaluate('newProjectInput.value'), path.join(home, 'asset'));
  assert.equal(directoryRequests.filter(value => value === path.join(home, 'asset')).length, beforeParent);
  results.push('Visible folder prefetch shares the click request; returning to the parent uses cached data');
  results.push('Click through nested directories and return to parent');

  await typePath('/');
  await waitFor(ready);
  assert.equal(await evaluate('newProjectUp.disabled'), true);
  await typePath(path.join(home, 'missing-parent', 'child'));
  await waitFor(() => evaluate('!!newProjectError.textContent'));
  assert.equal(await ready(), false);
  results.push('Root disables up navigation; missing parent blocks creation');

  await typePath(external);
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
  await waitFor(ready);
  assert.equal(creations.length, 0);
  assert.equal(await evaluate('newProjectInput.value'), external);
  results.push('Manual absolute path outside home; Enter navigates without creating');

  const beforeNewFolderHeight = await evaluate('newProjectModal.querySelector(".modal-box").getBoundingClientRect().height');
  const target = path.join(external, 'new-project');
  await typePath(target);
  await waitFor(ready);
  assert.equal(await evaluate('newProjectDirectories.textContent'), 'Will create this folder');
  assert.equal(await evaluate('newProjectModal.querySelector(".modal-box").getBoundingClientRect().height'), beforeNewFolderHeight);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  await screenshot('desktop-new-folder');
  rejectCreate = true;
  await click('#newProjectModal .confirm');
  await waitFor(() => evaluate('newProjectError.textContent==="Permission denied"'));
  assert.equal(await evaluate('newProjectInput.disabled'), false);
  rejectCreate = false;
  await click('#newProjectModal .confirm');
  await waitFor(() => evaluate('newProjectModal.style.display==="none" && document.body.classList.contains("new-session")'));
  assert.equal((await fs.stat(target)).isDirectory(), true);
  assert.equal(creations.at(-1).projectPath, realpathSync.native(target));
  await screenshot('created-session');
  results.push('New folder created only on Create, correct external path, failure retry, session opened');

  await evaluate('loadProjects("Browser")');
  await waitFor(() => evaluate('!!document.querySelector("[title=\\"New Project\\"]")'));
  await click('[title="New Project"]');
  await waitFor(ready);
  heldPath = external + '/';
  await typePath(external + '/');
  await waitFor(() => !!releaseHeld);
  await typePath(home + '/');
  await waitFor(ready);
  releaseHeld();
  heldPath = null;
  await pause(150);
  assert.equal(await evaluate('newProjectInput.value'), home + '/');
  assert.equal(await evaluate('newProjectDirectories.querySelectorAll("button").length'), 2);
  results.push('Delayed response does not overwrite a newer directory');

  offline = true;
  await typePath(external);
  await waitFor(() => evaluate('newProjectError.textContent==="Bridge offline"'));
  offline = false;
  await typePath(home + '/');
  await waitFor(ready);
  results.push('Bridge offline error and recovery');

  const longFolder = 'folder-with-a-long-name-for-checking-the-visible-end-of-the-selected-path';
  const longPath = path.join(home, longFolder);
  await fs.mkdir(longPath);
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await call('Emulation.setTouchEmulationEnabled', { enabled: true });
  await evaluate('closeNewProjectModal()');
  await evaluate("document.documentElement.classList.add('native-mobile')");
  await evaluate('createNewProject()');
  await waitFor(() => evaluate(`newProjectModal.style.display!=='none'&&newProjectInput.value===${JSON.stringify(home)}&&!document.querySelector('#newProjectModal .confirm').disabled`));
  assert.equal(await evaluate('newProjectInput.value'), home);
  const viewport = async (width, height) => {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
    await waitFor(() => evaluate(`newProjectModal.style.height==='${height}px'`));
  };
  const checkPhone = async () => {
    assert.equal(await evaluate(`(()=>{
      const box=newProjectModal.querySelector('.modal-box').getBoundingClientRect();
      const create=newProjectModal.querySelector('.confirm').getBoundingClientRect();
      return box.left>=0&&box.right<=visualViewport.width&&box.top>=0&&box.bottom<=visualViewport.height
        &&create.bottom<=visualViewport.height&&document.documentElement.scrollWidth<=innerWidth;
    })()`), true);
    assert.equal(await evaluate(`['#newProjectUp','#newProjectInput','#newProjectModal .confirm','#newProjectDirectories button'].every(selector=>{
      const r=document.querySelector(selector).getBoundingClientRect();return r.height>=44&&r.width>=44;
    })`), true);
  };
  for (const [width, height] of [[320, 568], [390, 844], [844, 390]]) {
    await viewport(width, height);
    await checkPhone();
    await screenshot('mobile-' + width);
  }
  await viewport(390, 340);
  await checkPhone();
  await screenshot('mobile-keyboard');
  await evaluate('document.querySelector("#newProjectDirectories button:first-child").click()');
  await waitFor(() => evaluate(`newProjectInput.value===${JSON.stringify(path.join(home, 'asset'))}&&!document.querySelector('#newProjectModal .confirm').disabled`));
  assert.equal(await evaluate('newProjectInput.value'), path.join(home, 'asset'));
  await evaluate('newProjectDirectories.scrollTop=newProjectDirectories.scrollHeight;true;');
  await waitFor(() => evaluate('newProjectDirectories.scrollTop>0'));
  await evaluate('newProjectUp.click()');
  await waitFor(() => evaluate(`newProjectInput.value===${JSON.stringify(home)}&&!document.querySelector('#newProjectModal .confirm').disabled`));
  assert.equal(await evaluate('newProjectInput.value'), home);
  await viewport(390, 844);
  await evaluate(`[...document.querySelectorAll('#newProjectDirectories button')].find(row=>row.dataset.path===${JSON.stringify(longPath)}).click()`);
  await waitFor(ready);
  assert.equal(await evaluate(`newProjectInput.value===${JSON.stringify(longPath)}
    &&newProjectInput.selectionStart===newProjectInput.value.length
    &&newProjectInput.selectionEnd===newProjectInput.value.length
    &&newProjectInput.scrollLeft>0
    &&newProjectInput.scrollWidth-newProjectInput.clientWidth-newProjectInput.scrollLeft<=2`), true);
  await screenshot('mobile-path-end');
  await evaluate('closeNewProjectModal()');
  await waitFor(() => evaluate('newProjectModal.style.display==="none"'));
  await evaluate('createNewProject()');
  await waitFor(() => evaluate(`newProjectModal.style.display!=='none'&&newProjectInput.value===${JSON.stringify(home)}&&!document.querySelector('#newProjectModal .confirm').disabled`));
  assert.equal(await evaluate('newProjectInput.value'), home);
  results.push('320/390 px phones, landscape, keyboard viewport, 44 px controls, navigation and scrollable folders');
  results.push('Selected long paths position the caret and horizontal scroll at the end');

  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(artifacts, 'results.json'), JSON.stringify({ results, errors }, null, 2));
  console.log(JSON.stringify({ passed: results.length, results, artifacts }, null, 2));
} catch (error) {
  await diagnose?.();
  throw error;
} finally {
  releaseHeld?.();
  releaseAsset?.();
  socket?.close();
  for (const ws of sockets.clients) ws.terminate();
  sockets.close();
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise(resolve => chrome.once('exit', resolve));
    chrome.kill('SIGTERM');
    await Promise.race([exited, pause(3000)]);
  }
  await server?.close();
  await fs.rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
