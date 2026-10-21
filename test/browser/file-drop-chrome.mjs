// CHROME_BIN=/path/to/chrome node test/browser/file-drop-chrome.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createTestServer } from '../frontend/helpers/vite.mjs';

const directory = path.resolve('.test-runs/file-drop-' + Date.now());
await mkdir(directory, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'baton-file-drop-'));
const stored = new Map(), images = [], puts = [];
let vite, browser, socket;
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/css/style.css"><link rel="stylesheet" href="/css/file-icons.css"></head><body>
<div class="top-bar">Baton</div><div id="content"><div class="messages">Drop files anywhere in this conversation</div></div>
<div id="input-bar"><div id="file-drop-hint" role="status">Drop files to add attachments</div><div id="img-preview-row"></div>
<div class="input-row"><input id="img-picker" type="file" multiple hidden onchange="onImagePicked(this)">
<button class="img-btn" onclick="document.getElementById('img-picker').click()">+</button>
<textarea id="msg-input" onpaste="onInputPaste(event)">Keep this draft</textarea>
<button id="send-btn" onclick="window.sent++">Send</button></div></div>
<script type="module">
window.apiPost = async (url, body) => (await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
const {state} = await import('/js/state.js'); window.state=state; window.sent=0;
state.appState.session='test'; state.activeThreadCanSend=true;
await import('/js/components/image.js'); window.ready=true;
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
    plugins: [{ name: 'file-drop-fixture', configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url === '/__file_drop') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
        if (!request.url.startsWith('/api/') && !request.url.startsWith('/upload/')) return next();
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        response.setHeader('Content-Type', 'application/json');
        if (request.url === '/api/bridge/file-prepare') {
          const file = JSON.parse(bytes);
          assert.match(file.contentHash, /^[0-9a-f]{64}$/);
          const key = file.contentHash.slice(0, 32) + '.' + file.name.split('.').at(-1);
          if (stored.get(key)?.bytes) { response.end(JSON.stringify({ key, exists: true })); return; }
          stored.set(key, file);
          response.end(JSON.stringify({ key, url: '/upload/' + key, headers: {} }));
        } else if (request.url.startsWith('/upload/')) {
          const key = request.url.split('/').at(-1);
          stored.get(key).bytes = bytes;
          puts.push(key);
          response.end('{}');
        } else if (request.url === '/api/bridge/upload-image') {
          images.push(JSON.parse(bytes));
          response.end('{}');
        } else response.writeHead(404).end();
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
  const pending = new Map(), errors = [];
  socket.on('message', raw => {
    const packet = JSON.parse(raw);
    if (packet.id) {
      const entry = pending.get(packet.id); pending.delete(packet.id);
      if (packet.error) entry.reject(new Error(JSON.stringify(packet.error))); else entry.resolve(packet.result);
    } else if (packet.method === 'Runtime.exceptionThrown') errors.push(packet.params.exceptionDetails);
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
  await call('Runtime.enable');
  await call('Page.enable');
  await call('Page.navigate', { url: 'http://127.0.0.1:' + vite.httpServer.address().port + '/__file_drop' });
  await waitFor(() => evaluate('window.ready'));
  const text = Buffer.from('A file dropped into the conversation.\n');
  const textPath = path.join(directory, '拖拽测试.txt'), imagePath = path.join(directory, 'large-image.png');
  await writeFile(textPath, text);
  const png = await evaluate(`(()=>{const canvas=document.createElement('canvas');canvas.width=2560;canvas.height=1440;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#388bfd';ctx.fillRect(0,0,2560,1440);
    return canvas.toDataURL('image/png').split(',')[1];})()`);
  await writeFile(imagePath, Buffer.from(png, 'base64'));
  const drag = async (type, files) => call('Input.dispatchDragEvent', {
    type, x: 200, y: 100, data: { items: [], files, dragOperationsMask: 1 },
  });
  const drop = async files => {
    await drag('dragEnter', files); await drag('dragOver', files); await drag('drop', files);
  };
  // Chrome supplies actual disk-backed Files; neither the FileList nor the
  // attachment/upload functions are mocked.
  await drag('dragEnter', [textPath, imagePath]);
  await drag('dragOver', [textPath, imagePath]);
  assert.equal(await evaluate('getComputedStyle(document.getElementById("file-drop-hint")).display'), 'flex');
  await screenshot('drag-hint');
  await drag('drop', [textPath, imagePath]);
  await waitFor(() => evaluate('state.stagedImages.length===2 && state.stagedImages.every(file=>file.uploaded)'));
  const textHash = createHash('sha256').update(text).digest('hex');
  const file = stored.get(textHash.slice(0, 32) + '.txt');
  assert.equal(file.contentHash, textHash);
  assert.deepEqual(file.bytes, text);
  assert.equal(images.length, 1);
  assert.equal(Buffer.from(images[0].data, 'base64').subarray(0, 2).toString('hex'), 'ffd8');
  await waitFor(() => evaluate('document.querySelector(".img-thumb img").naturalWidth===1280'));
  assert.deepEqual(await evaluate(`(()=>{const img=document.querySelector('.img-thumb img');
    return [img.naturalWidth,img.naturalHeight];})()`), [1280, 720]);
  assert.equal(await evaluate('document.getElementById("msg-input").value'), 'Keep this draft');
  assert.equal(await evaluate('sent'), 0);
  assert.equal(await evaluate('getComputedStyle(document.getElementById("file-drop-hint")).display'), 'none');
  await screenshot('dropped-attachments');
  await drop([textPath]);
  await waitFor(() => evaluate('state.stagedImages.length===3 && state.stagedImages.every(file=>file.uploaded)'));
  assert.equal(puts.length, 1, 'repeated drops must reuse stored content');
  await call('DOM.enable');
  const { root } = await call('DOM.getDocument');
  const { nodeId } = await call('DOM.querySelector', { nodeId: root.nodeId, selector: '#img-picker' });
  await call('DOM.setFileInputFiles', { nodeId, files: [textPath] });
  await waitFor(() => evaluate('state.stagedImages.length===4 && state.stagedImages.every(file=>file.uploaded)'));
  assert.equal(puts.length, 1, 'the picker and drag must share content deduplication');
  await evaluate(`(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['pasted'],'paste.txt',{type:'text/plain'}));
    document.getElementById('msg-input').dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));})()`);
  await waitFor(() => evaluate('state.stagedImages.length===5 && state.stagedImages.every(file=>file.uploaded)'));
  await evaluate('document.getElementById("msg-input").readOnly=true');
  await drop([textPath]);
  assert.equal(await evaluate('state.stagedImages.length'), 5);
  assert.equal(await evaluate('location.pathname'), '/__file_drop');
  assert.equal(await evaluate('sent'), 0);
  assert.equal(await evaluate('document.getElementById("msg-input").value'), 'Keep this draft');
  assert.deepEqual(errors, []);
  await writeFile(path.join(directory, 'results.json'), JSON.stringify({
    ok: true, checks: ['disk-backed browser multi-file drop', 'composer hint', 'SHA-256 and original uploaded bytes',
      'real image compression to 1280x720 JPEG', 'shared picker/drop deduplication', 'clipboard file regression',
      'read-only rejection', 'unchanged draft', 'no automatic send', 'no page navigation or errors'],
  }, null, 2));
  console.log('Browser verification passed: ' + directory);
} finally {
  socket?.close(); browser?.kill();
  await vite?.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
