import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { toolPreview } from '../../bridge/tool-preview.mjs';
import { readToolDetails } from '../../bridge/tool-details.mjs';
import { sendTextFrames } from '../../bridge/project/ws-frames.mjs';
import { createTestServer } from '../frontend/helpers/vite.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'baton-chrome-tool-preview-'));
const server = await createTestServer({ server: { host: '127.0.0.1', port: 0, strictPort: false, open: false } });
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let chrome;
let socket;
let failures = [];
const results = [];

async function waitFor(read, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await pause(50);
  }
  throw new Error('Timed out waiting for browser state');
}

try {
  await server.listen();
  const origin = 'http://127.0.0.1:' + server.httpServer.address().port;
  chrome = spawn(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--user-data-dir=' + path.join(directory, 'profile'), '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,900',
    ...(process.argv.includes('--headed') ? [] : ['--headless=new']), 'about:blank',
  ], { stdio: 'ignore' });
  chrome.on('error', error => failures.push({ message: error.message }));
  const port = await waitFor(async () => {
    try { return Number((await readFile(path.join(directory, 'profile/DevToolsActivePort'), 'utf8')).split('\n')[0]); }
    catch { return false; }
  });
  const debugging = 'http://127.0.0.1:' + port;
  await waitFor(async () => {
    const targets = await (await fetch(debugging + '/json/list')).json();
    const target = targets.find(item => item.type === 'page')
      || await (await fetch(debugging + '/json/new?about:blank', { method: 'PUT' })).json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    socket.on('error', () => {});
    return new Promise(resolve => {
      socket.once('open', () => resolve(true));
      socket.once('error', () => resolve(false));
    });
  });
  let nextId = 0;
  const pending = new Map();
  socket.on('message', raw => {
    const packet = JSON.parse(raw);
    if (packet.id) {
      const command = pending.get(packet.id);
      pending.delete(packet.id);
      if (packet.error) command.reject(new Error(JSON.stringify(packet.error)));
      else command.resolve(packet.result);
    } else if (packet.method === 'Runtime.exceptionThrown') failures.push(packet.params.exceptionDetails);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, replMode: true });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  const screenshot = async name => {
    const image = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(directory, name + '.png'), Buffer.from(image.data, 'base64'));
  };
  const click = async selector => {
    const point = await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.scrollIntoView({block:'nearest'});const rect=node.getBoundingClientRect();return{x:rect.x+8,y:rect.y+rect.height/2}})()`);
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  };
  await call('Page.enable');
  await call('Runtime.enable');
  if (process.argv.includes('--mobile')) {
    await call('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
    });
  }

  const fullMessages = [
    { uuid: 'user', type: 'user', content: 'Inspect tool previews.', timestamp: '2026-10-13T00:00:00Z' },
    { uuid: 'bash-use', type: 'assistant', content: [{ type: 'tool_use', id: 'bash', name: 'Bash', input: { command: 'printf '.repeat(200) } }] },
    { uuid: 'bash-result', type: 'user', content: [{ type: 'tool_result', tool_use_id: 'bash', content: '完整输出🙂'.repeat(10000) + 'OUTPUT-END' }] },
    { uuid: 'separator', type: 'assistant', content: [{ type: 'text', text: 'Now inspect the Edit.' }] },
    { uuid: 'edit-use', type: 'assistant', content: [{ type: 'tool_use', id: 'edit', name: 'Edit', input: { file_path: '/workspace/example.js', old_string: '// same prefix\n'.repeat(100) + 'oldTail();', new_string: '// same prefix\n'.repeat(100) + 'newTail();' } }] },
    { uuid: 'edit-result', type: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit', content: 'Modified successfully.' }] },
    { uuid: 'local-use', type: 'assistant', content: [{ type: 'tool_use', id: 'local', name: 'Bash', input: { command: 'echo local' } }] },
    { uuid: 'local-result', type: 'user', content: [{ type: 'tool_result', tool_use_id: 'local', content: 'Available local output\n'.repeat(8) + 'LOCAL-END' }] },
  ];
  const sourcePath = path.join(directory, 'original.jsonl');
  await writeFile(sourcePath, fullMessages.map(message => JSON.stringify({ uuid: message.uuid, type: message.type, message: { content: message.content } })).join('\n'));
  const responses = {};
  for (const id of ['bash', 'edit']) {
    const frames = [];
    sendTextFrames({ action: 'tool_details', ok: true }, JSON.stringify(readToolDetails(sourcePath, 'browser-snapshot', 'claude', [id])), frame => frames.push(frame));
    assert.ok(frames.every(frame => Buffer.byteLength(JSON.stringify(frame)) < 31000));
    responses[id] = frames;
  }
  assert.ok(responses.bash.length > 1);
  const editText = fullMessages.find(message => message.uuid === 'edit-use').content[0].input.new_string;
  const fileText = '// before\n// before edit\n' + editText + '\n// after edit';
  const setup = await readFile(new URL('./fixtures/history-snapshot-setup.js', import.meta.url), 'utf8');
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: setup + `
      snapshotProbe.hold=false;
      snapshotProbe.snapshot=${JSON.stringify(fullMessages.map(toolPreview))};
      snapshotProbe.detailRequests=[];
      snapshotProbe.fileText=${JSON.stringify(fileText)};
      snapshotProbe.responses=${JSON.stringify(responses)};
      const originalSend=WebSocket.prototype.send;
      WebSocket.prototype.send=function(payload){
        originalSend.call(this,payload);
        const message=JSON.parse(payload);
        if(message.action==='tool_details')snapshotProbe.detailRequests.push(message);
        if(message.action==='project_files'&&message.operation==='read'){
          queueMicrotask(()=>this.onmessage({data:JSON.stringify({
            action:'project_files',requestId:message.requestId,ok:true,sequence:0,complete:true,
            path:message.path,content:snapshotProbe.fileText,contentVersion:snapshotProbe.fileVersion||'v1',
          })}));
        }
      };
      snapshotProbe.releaseDetails=function(){
        const request=snapshotProbe.detailRequests.at(-1);
        for(const frame of snapshotProbe.responses[request.toolUseIds[0]].slice().reverse()){
          snapshotProbe.sockets.at(-1).onmessage({data:JSON.stringify({...frame,requestId:request.requestId})});
        }
      };
    `,
  });
  await call('Page.navigate', { url: origin + '/#/Browser/project/codex%3Abrowser-snapshot' });
  await waitFor(() => evaluate('!!document.querySelector("[data-tool-id=bash] .tool-header")&&!document.querySelector(".skeleton-messages")'));
  await waitFor(() => evaluate('snapshotProbe.sockets.at(-1)?.readyState===1'));
  await pause(100);
  const initialRequests = await evaluate('snapshotProbe.requests.length');
  assert.equal(await evaluate('snapshotProbe.detailRequests.length'), 0);
  assert.equal(await evaluate('document.querySelectorAll(".d2h-wrapper").length'), 0);
  await screenshot('collapsed-previews');
  await click('[data-tool-id="bash"] .tool-header');
  assert.equal(await evaluate('snapshotProbe.detailRequests.length'), 0);
  assert.equal(await evaluate('document.querySelector("[data-tool-id=bash]").classList.contains("tool-details-collapsed")'), false);
  const clamped = await evaluate(`(() => {
    const node = document.querySelector('[data-tool-id=bash]');
    const value = node.querySelector('.tool-value');
    return {
      height: value.clientHeight, scrollHeight: value.scrollHeight,
      buttons: node.querySelectorAll('.clamp-btn').length,
    };
  })()`);
  assert.ok(clamped.height < 100);
  assert.ok(clamped.scrollHeight > clamped.height);
  assert.equal(clamped.buttons, 1);
  await screenshot('local-preview');
  await click('[data-tool-id="bash"] .tool-value');
  await waitFor(() => evaluate('snapshotProbe.detailRequests.length===1'));
  assert.equal(await evaluate('!!document.querySelector(".tool-preview-more .loading-spinner")'), true);
  const loadingAlignment = await evaluate(`(() => {
    const button = document.querySelector('.tool-preview-more[aria-busy="true"]');
    const spinner = button.querySelector('.loading-spinner').getBoundingClientRect();
    const bounds = button.getBoundingClientRect();
    return Math.abs(spinner.y + spinner.height / 2 - bounds.y - bounds.height / 2);
  })()`);
  assert.ok(loadingAlignment <= 1, `Loading indicator vertical offset: ${loadingAlignment}px`);
  assert.equal(await evaluate('document.querySelector(".tool-preview-more[aria-busy=true]").textContent.trim()'), '');
  assert.equal(await evaluate('document.querySelector("[data-tool-id=bash]").classList.contains("tool-details-collapsed")'), false);
  await screenshot('loading');
  await evaluate('snapshotProbe.releaseDetails()');
  await waitFor(() => evaluate('document.querySelector("[data-tool-id=bash]").textContent.includes("OUTPUT-END")'));
  assert.equal(await evaluate('document.querySelector("[data-tool-id=bash]").classList.contains("tool-details-collapsed")'), false);
  await click('[data-tool-id="bash"] .tool-header');
  await click('[data-tool-id="bash"] .tool-header');
  assert.equal(await evaluate('snapshotProbe.detailRequests.length'), 1);
  await screenshot('full-output');
  await click('[data-tool-id="edit"] .file-link');
  await waitFor(() => evaluate('!!document.querySelector("#fileOverlay .file-content")'));
  assert.equal(await evaluate('document.querySelectorAll("#fileOverlay .file-line-hl").length'), 0);
  assert.equal(await evaluate('snapshotProbe.detailRequests.length'), 1);
  await evaluate('closeFileViewer({refresh:false})');
  await click('[data-tool-id="edit"] .tool-header');
  await waitFor(() => evaluate('snapshotProbe.detailRequests.length===2'));
  assert.equal(await evaluate('!!document.querySelector("[data-tool-id=edit] .tool-header .loading-spinner")'), true);
  assert.equal(await evaluate('document.querySelector("[data-tool-id=edit] .tool-detail-loading").textContent.trim()'), '');
  assert.equal(await evaluate('document.querySelector("[data-tool-id=edit] .tool-status")'), null);
  assert.equal(await evaluate('document.querySelector("[data-tool-id=edit] .tool-preview-more")'), null);
  assert.equal(await evaluate('document.querySelector("[data-tool-id=edit]").textContent.includes("same prefix")'), false);
  assert.equal(await evaluate('document.querySelectorAll(".d2h-wrapper").length'), 0);
  await screenshot('edit-header-loading');
  await evaluate('snapshotProbe.releaseDetails()');
  await waitFor(() => evaluate('document.querySelectorAll(".d2h-wrapper").length===1'));
  assert.equal(await evaluate('document.querySelector(".d2h-wrapper").textContent.includes("newTail")'), true);
  await click('[data-tool-id="edit"] .tool-header');
  await click('[data-tool-id="edit"] .tool-header');
  assert.equal(await evaluate('snapshotProbe.detailRequests.length'), 2);
  assert.equal(await evaluate('!!document.querySelector("[data-tool-id=edit] .loading-spinner")'), false);
  assert.equal(await evaluate('snapshotProbe.requests.length'), initialRequests);
  await screenshot('full-edit');
  await click('[data-tool-id="edit"] .file-link');
  await waitFor(() => evaluate('!!document.querySelector("#fileOverlay .file-line-hl")'));
  const highlighted = await evaluate('[...document.querySelectorAll("#fileOverlay .file-line-hl")].map(node=>Number(node.textContent))');
  assert.deepEqual(highlighted, [2 + editText.split('\n').length]);
  assert.equal(await evaluate('snapshotProbe.detailRequests.length'), 2);
  await screenshot('full-file-location');
  await evaluate('closeFileViewer({refresh:false})');
  await evaluate('snapshotProbe.fileText="inserted line\\n"+snapshotProbe.fileText;snapshotProbe.fileVersion="v2"');
  await click('[data-tool-id="edit"] .file-link');
  await waitFor(() => evaluate('!!document.querySelector("#fileOverlay .file-line-hl")'));
  assert.deepEqual(await evaluate('[...document.querySelectorAll("#fileOverlay .file-line-hl")].map(node=>Number(node.textContent))'),
    [3 + editText.split('\n').length]);
  assert.equal(await evaluate('snapshotProbe.detailRequests.length'), 2);
  await screenshot('moved-file-location');
  await evaluate('closeFileViewer({refresh:false})');
  await click('[data-tool-id="local"] .tool-header');
  await waitFor(() => evaluate('!!document.querySelector("[data-tool-id=local] .clamp-btn")'));
  assert.equal(await evaluate('document.querySelector("[data-tool-id=local] .tool-body-content").classList.contains("open")'), false);
  await click('[data-tool-id="local"] .clamp-btn');
  assert.equal(await evaluate('document.querySelector("[data-tool-id=local] .tool-body-content").classList.contains("open")'), true);
  assert.equal(await evaluate('document.querySelector("[data-tool-id=local] .clamp-btn").textContent'), 'Show less');
  assert.equal(await evaluate('snapshotProbe.detailRequests.length'), 2);
  await screenshot('local-complete-expanded');
  assert.deepEqual(failures, []);
  await writeFile(path.join(directory, 'results.json'), JSON.stringify({ requests: await evaluate('snapshotProbe.detailRequests'), frames: Object.fromEntries(Object.entries(responses).map(([id, frames]) => [id, frames.length])), errors: failures }, null, 2));
  console.log(JSON.stringify({ passed: true, artifacts: directory, detailRequests: 2 }, null, 2));
} finally {
  socket?.close();
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise(resolve => chrome.once('exit', resolve));
    chrome.kill('SIGTERM');
    await Promise.race([exited, pause(3000)]);
  }
  await server.close();
  await rm(path.join(directory, 'profile'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
