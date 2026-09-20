import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createTestServer } from '../frontend/helpers/vite.mjs';

const directory = path.resolve('.test-runs/attachments-' + Date.now());
await mkdir(directory, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'baton-attachments-chrome-'));
const files = new Map();
const uploads = [];
let browser;
let socket;
let vite;
const storage = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET,PUT,OPTIONS');
  if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
  const key = request.url.split('/').at(-1);
  const file = files.get(key);
  if (!file) { response.writeHead(404).end(); return; }
  if (request.method === 'PUT') {
    uploads.push({ route: request.url, length: Number(request.headers['content-length']), headers: request.headers });
    if (request.url.startsWith('/accelerated/')) {
      request.resume(); response.writeHead(503).end(); return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    file.bytes = Buffer.concat(chunks);
    response.writeHead(200).end();
  } else {
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(file.name));
    response.end(file.bytes);
  }
});
await new Promise(resolve => storage.listen(0, '127.0.0.1', resolve));
const storageUrl = 'http://127.0.0.1:' + storage.address().port;
const fileOverlay = (await readFile(path.resolve('web/index.html'), 'utf8')).split('<!-- File overlay -->')[1].split('</body>')[0];
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/css/style.css"><link rel="stylesheet" href="/css/file-icons.css"></head><body>
<div id="content"><div class="messages"></div></div><div id="input-bar"><div id="img-preview-row"></div>
<div class="input-row"><input id="img-picker" type="file" multiple hidden onchange="onImagePicked(this)">
<button class="img-btn" onclick="document.getElementById('img-picker').click()">+</button>
<textarea id="msg-input" placeholder="Send a message..."></textarea><button id="send-btn" onclick="onSendBtnClick()">Send</button></div></div>
<div id="imgOverlay" style="display:none"><img id="imgOverlayImg"></div>
${fileOverlay}
<script type="module">
window.api = async url => { const response = await fetch(url); if (!response.ok) throw Error('API ' + response.status); return response.json(); };
window.apiPost = async (url, body) => (await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
window.clampOverflow = () => {}; window.updateSpinner = () => {};
const helpers = await import('/js/components/attachment.js'); window.esc = helpers.escapeAttachment;
const {state} = await import('/js/state.js'); window.state = state; window.sent = [];
state.activeThreadCanSend = true; state.wsSessionId = 'local-test'; state.appState.session = 'local-test';
state.appState.device = 'test'; state.appState.project = {hash:'project'};
state.ws = {readyState:1,send(raw){window.sent.push(JSON.parse(raw));queueMicrotask(()=>state.pendingSentMessages.forEach(item=>item.serverReceived=true));}};
await import('/js/components/image.js'); await import('/js/components/message.js');
await import('/js/project/file-viewer.js'); await import('/js/ws.js'); window.ready = true;
</script></body></html>`;

const waitFor = async callback => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await callback();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Browser verification timed out');
};

try {
  vite = await createTestServer({ configFile: false, root: path.resolve('web'), appType: 'custom',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    plugins: [{ name: 'attachment-fixture', configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url === '/__attachment_test') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
        if (request.url === '/api/bridge/file-prepare') {
          let body = ''; for await (const chunk of request) body += chunk;
          const file = JSON.parse(body);
          const key = String(files.size + 1).padStart(32, '0') + '.' + file.name.split('.').at(-1);
          files.set(key, file);
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ key, url: storageUrl + '/accelerated/' + key,
            fallbackUrl: storageUrl + '/standard/' + key, headers: { 'Content-Type': 'application/octet-stream',
              'x-amz-meta-filename': encodeURIComponent(file.name) } }));
          return;
        }
        if (request.url.startsWith('/api/bridge/file-url/')) {
          const key = request.url.split('/').at(-1), file = files.get(key);
          if (!file?.bytes) { response.writeHead(404).end(); return; }
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ key, name: file.name, size: file.bytes.length,
            contentType: file.contentType, previewType: 'application/octet-stream',
            url: storageUrl + '/download/' + key, previewUrl: storageUrl + '/download/' + key }));
          return;
        }
        next();
      });
    } }],
  });
  await vite.listen();
  browser = spawn(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
    '--user-data-dir=' + profile, '--window-size=1024,800', 'about:blank',
  ], { stdio: 'ignore' });
  const port = await waitFor(async () => {
    try { return Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
    catch { return null; }
  });
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise(resolve => socket.once('open', resolve));
  let sequence = 0;
  const pending = new Map(), errors = [], completedDownloads = new Set();
  socket.on('message', raw => {
    const packet = JSON.parse(raw);
    if (packet.id) {
      const entry = pending.get(packet.id); pending.delete(packet.id);
      if (packet.error) entry.reject(new Error(JSON.stringify(packet.error))); else entry.resolve(packet.result);
    } else if (packet.method === 'Runtime.exceptionThrown') errors.push(packet.params.exceptionDetails);
    else if (packet.method.endsWith('.downloadProgress') && packet.params.state === 'completed') completedDownloads.add(packet.params.guid);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const screenshot = async name => writeFile(path.join(directory, name + '.png'),
    Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await call('Runtime.enable'); await call('Page.enable');
  const downloadPath = path.join(directory, 'downloads');
  await mkdir(downloadPath);
  await call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath, eventsEnabled: true });
  await call('Page.navigate', { url: 'http://127.0.0.1:' + vite.httpServer.address().port + '/__attachment_test' });
  await waitFor(() => evaluate('window.ready'));
  await evaluate(`(()=>{const input=document.getElementById('img-picker');const transfer=new DataTransfer();
    transfer.items.add(new File([new Uint8Array(8*1024*1024).fill(80)],'路线图 [2026].pptx'));
    transfer.items.add(new File(['word'],'需求.docx')); transfer.items.add(new File(['sheet'],'预算.xlsx'));
    input.files=transfer.files; input.dispatchEvent(new Event('change'));})()`);
  assert.equal(await evaluate('document.getElementById("send-btn").disabled'), true);
  await waitFor(() => evaluate('state.stagedImages.length === 3 && state.stagedImages.every(file=>file.uploaded)'));
  assert.equal(uploads.length, 6);
  const deck = [...files.values()][0];
  assert.equal(deck.bytes.length, 8 * 1024 * 1024);
  assert.ok(deck.bytes.every(byte => byte === 80));
  assert.equal(uploads[0].length, 8 * 1024 * 1024);
  assert.ok(uploads.every(upload => !upload.headers['x-api-key']));
  await evaluate(`(()=>{const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;
    const context=canvas.getContext('2d');context.fillStyle='#388bfd';context.fillRect(0,0,64,64);
    state.stagedImages.unshift({key:'photo.jpg',dataUrl:canvas.toDataURL('image/jpeg'),uploaded:true});renderStagedImages();})()`);
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".staged-files img")).width'), '14px');
  assert.equal(await evaluate('document.querySelector(".staged-files").getBoundingClientRect().top > document.querySelector(".img-thumb").getBoundingClientRect().top'), true);
  await screenshot('desktop-attachments');
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate('document.body.scrollWidth <= innerWidth'), true);
  await screenshot('mobile-attachments');
  await evaluate('document.querySelector(".staged-files .attachment-file").click()');
  await waitFor(() => evaluate('!!document.querySelector(".attachment-preview-info")'));
  assert.equal(await evaluate('document.querySelector("#fileOverlayTitle").textContent'), '路线图 [2026].pptx');
  assert.equal(await evaluate('document.getElementById("fileOverlay").scrollWidth <= innerWidth'), true);
  await screenshot('office-preview');
  await evaluate('document.getElementById("file-download-btn").click()');
  const downloaded = path.join(downloadPath, '路线图 [2026].pptx');
  await waitFor(async () => { try { return (await readFile(downloaded)).equals(deck.bytes); } catch { return false; } });
  assert.equal(await evaluate('document.getElementById("file-download-status").textContent'), 'Download started.');
  assert.match(await evaluate('location.pathname'), /__attachment_test/);
  await evaluate('document.getElementById("file-download-btn").click()');
  await waitFor(() => completedDownloads.size === 2);
  assert.deepEqual(await readFile(downloaded), deck.bytes);
  await evaluate('closeFileViewer(); document.getElementById("send-btn").click()');
  assert.equal(await evaluate('sent.length'), 1);
  assert.match(await evaluate('sent[0].text'), /Please review the attached files/);
  assert.equal(await evaluate('document.querySelectorAll(".msg-attachments .attachment-file").length'), 3);
  assert.equal(await evaluate('state.stagedImages.length'), 0);
  await evaluate('document.querySelector(".messages").innerHTML = renderUserBubble({type:"user",content:sent[0].text})');
  assert.equal(await evaluate('document.querySelectorAll(".msg-attachments .attachment-file").length'), 3);
  assert.deepEqual(errors, []);
  await writeFile(path.join(directory, 'results.json'), JSON.stringify({
    ok: true, uploadedBytes: deck.bytes.length, putRequests: uploads.length,
    checks: ['cross-origin raw PUT', 'acceleration fallback', 'Office icons', 'mobile second row',
      'shared preview overlay', '8 MiB original download', 'Chinese filename', 'duplicate download',
      'attachment-only send', 'historical filename rendering'],
  }, null, 2));
  console.log('Browser verification passed: ' + directory);
} finally {
  socket?.close(); browser?.kill();
  await vite?.close();
  storage.closeAllConnections(); await new Promise(resolve => storage.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
