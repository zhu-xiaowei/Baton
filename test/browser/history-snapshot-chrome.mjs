import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createTestServer } from '../frontend/helpers/vite.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'agentpeek-chrome-snapshot-'));
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
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,900',
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
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: await readFile(new URL('./fixtures/history-snapshot-setup.js', import.meta.url), 'utf8'),
  });
  await call('Page.navigate', { url: origin + '/#/Browser/project/codex%3Abrowser-snapshot' });
  await waitFor(() => evaluate('window.snapshotProbe?.requests.length===1'));
  assert.equal(await evaluate('!!document.querySelector(".skeleton-messages")'), true);
  await screenshot('initial-skeleton');
  await evaluate('snapshotProbe.release()');
  await waitFor(() => evaluate('!!document.querySelector(".tool-node")'));
  await evaluate('window.testState=(await import("/js/state.js")).state');
  assert.equal(await evaluate('testState.wsAllMessages.length'), 200);
  assert.equal(await evaluate('document.querySelectorAll(".tool-node").length'), 50);
  assert.equal(await evaluate('document.querySelectorAll(".tool-details-collapsed").length'), 50);
  assert.equal(await evaluate('document.querySelectorAll(".d2h-wrapper").length'), 0);
  await waitFor(() => evaluate('Math.abs(content.scrollHeight-content.clientHeight-content.scrollTop)<2'));
  results.push('initial skeleton, latest 200, collapsed tools, deferred diffs, bottom placement');

  await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 600, y: 300, deltaX: 0, deltaY: -4200 });
  await waitFor(() => evaluate('testState.stickBottom===false'));
  await pause(150);
  await evaluate(`window.oldContainer=document.querySelector('.messages');window.anchor=[...content.querySelectorAll('[data-message-id]')].find(node=>node.getBoundingClientRect().bottom>content.getBoundingClientRect().top);window.anchorId=anchor.dataset.messageId;window.anchorTop=anchor.getBoundingClientRect().top;snapshotProbe.hold=true;snapshotProbe.snapshot=snapshotProbe.history(80);window.loading=refreshSessionMessages()`);
  assert.equal(await evaluate('oldContainer.isConnected&&!document.querySelector(".skeleton-messages")'), true);
  await evaluate('snapshotProbe.release();loading');
  assert.equal(await evaluate('testState.wsAllMessages.length'), 280);
  assert.equal(await evaluate('testState.wsAllMessages[0].uuid'), 'message-0');
  assert.ok(Math.abs(await evaluate('document.querySelector(`[data-message-id="${anchorId}"]`).getBoundingClientRect().top-anchorTop')) < 1);
  results.push('boundary replacement preserves history and reading anchor');

  await evaluate('window.oldContainer=document.querySelector(".messages");window.oldTop=content.scrollTop;await refreshSessionMessages()');
  assert.equal(await evaluate('oldContainer===document.querySelector(".messages")&&content.scrollTop===oldTop'), true);
  await evaluate('snapshotProbe.fail=true;window.failed=await refreshSessionMessages();snapshotProbe.fail=false');
  assert.equal(await evaluate('failed.ok===false&&oldContainer===document.querySelector(".messages")'), true);
  results.push('unchanged snapshots and failed requests keep the existing DOM');

  await evaluate('snapshotProbe.hold=true;snapshotProbe.snapshot=snapshotProbe.history(120);window.requestCount=snapshotProbe.requests.length');
  const background = await (await fetch(debugging + '/json/new?about:blank', { method: 'PUT' })).json();
  await waitFor(() => evaluate('document.visibilityState==="hidden"'));
  await call('Page.bringToFront');
  await waitFor(() => evaluate('snapshotProbe.requests.length===requestCount+1'));
  await evaluate('snapshotProbe.release()');
  await waitFor(() => evaluate('testState.wsAllMessages.length===320'));
  await fetch(debugging + '/json/close/' + background.id);
  results.push('actual Chrome tab hide/show uses the shared loader');

  await evaluate('snapshotProbe.hold=true;window.loading=refreshSessionMessages();window.sendStart=snapshotProbe.sends.length');
  for (let number = 1; number <= 5; number++) {
    await evaluate('document.getElementById("msg-input").focus()');
    await call('Input.insertText', { text: String(number) });
    await click('#send-btn');
  }
  await evaluate('window.fiveSends=[...new Map(snapshotProbe.sends.slice(sendStart).filter(item=>item.action==="send_message").map(item=>[item.turnId,item])).values()];for(let index=4;index>=0;index--)snapshotProbe.complete(fiveSends[index],index+1)');
  assert.deepEqual(await evaluate('fiveSends.map(item=>item.text)'), ['1', '2', '3', '4', '5']);
  assert.equal(await evaluate('content.innerText.includes("Reply to 1")'), false);
  await evaluate('snapshotProbe.release();loading');
  await waitFor(() => evaluate('testState.pendingSentMessages.length===0&&!testState.wsRunning'));
  assert.deepEqual(await evaluate('fiveSends.map(item=>{const user=document.querySelector(`[data-anchor="${item.turnId}"]`);return[user.querySelector(".msg-text").innerText,user.nextElementSibling.innerText,user.nextElementSibling.dataset.turnId===item.turnId]})'), [1, 2, 3, 4, 5].map(number => [String(number), 'Reply to ' + number, true]));
  await screenshot('five-sends');
  results.push('five UI sends during REST, reverse completion, correct question/reply order');

  await evaluate('snapshotProbe.snapshot=snapshotProbe.history(500);window.requestCount=snapshotProbe.requests.length;snapshotProbe.sockets.at(-1).close()');
  await waitFor(() => evaluate('snapshotProbe.requests.length>requestCount&&testState.wsAllMessages[0]?.uuid==="message-500"'));
  assert.equal(await evaluate('testState.wsAllMessages.length'), 200);
  results.push('WS disconnect/reconnect and missing boundary replace the full window');
  await evaluate('snapshotProbe.snapshot=snapshotProbe.history(520);window.requestCount=snapshotProbe.requests.length;snapshotProbe.event({action:"stream_turn_start",turnId:"compact",seq:0});snapshotProbe.event({action:"stream_end",turnId:"compact",seq:1,recoveryRequired:true})');
  await waitFor(() => evaluate('snapshotProbe.requests.length>requestCount&&testState.wsAllMessages.at(-1)?.uuid==="message-719"'));
  assert.equal(await evaluate('testState.wsAllMessages.length'), 220);
  results.push('compact stream end uses the same latest-200 replacement');

  await evaluate('document.querySelectorAll(".diff-container")[document.querySelectorAll(".diff-container").length-1].closest(".tool-node").querySelector(".tool-header").id="test-diff-header"');
  await click('#test-diff-header');
  await waitFor(() => evaluate('document.querySelectorAll(".d2h-wrapper").length===1'));
  await screenshot('expanded-diff');
  results.push('real click lazily renders one Edit diff');
  assert.equal(await evaluate('snapshotProbe.requests.every(request=>request.limit==="200"&&!request.after)'), true);
  assert.deepEqual(failures, []);
  await writeFile(path.join(directory, 'results.json'), JSON.stringify({ results, errors: failures }, null, 2));
  console.log(JSON.stringify({ passed: results.length, results, artifacts: directory }, null, 2));
} finally {
  socket?.close();
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise(resolve => chrome.once('exit', resolve));
    chrome.kill('SIGTERM');
    await Promise.race([exited, pause(3000)]);
  }
  await server.close();
  await rm(path.join(directory, 'profile'), { recursive: true, force: true });
}
