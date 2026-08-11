import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { PassThrough, Writable } from 'stream';
import test from 'node:test';
import { CodexAppServerClient } from '../../../bridge/codex-app-server.mjs';

function fakeProcess() {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new Writable({
    write(chunk, _encoding, done) {
      proc.writes.push(JSON.parse(chunk.toString()));
      done();
    },
    final(done) {
      done();
      queueMicrotask(() => proc.emit('close', 0, null));
    },
  });
  proc.writes = [];
  proc.killed = false;
  proc.kill = () => {
    proc.killed = true;
    proc.emit('close', 0, 'SIGTERM');
  };
  return proc;
}

async function waitForWrite(proc, method) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const message = proc.writes.find((entry) => entry.method === method);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`missing write for ${method}`);
}

test('app-server client initializes and pairs interleaved responses', async (t) => {
  const proc = fakeProcess();
  const client = new CodexAppServerClient({
    bin: '/fake/codex',
    spawnFn: () => proc,
    requestTimeout: 1000,
  });
  t.after(() => client.stop());

  const started = client.start();
  const init = await waitForWrite(proc, 'initialize');
  proc.stdout.write(`${JSON.stringify({ id: init.id, result: { userAgent: 'test' } })}\n`);
  await started;
  assert.ok(proc.writes.some((entry) => entry.method === 'initialized'));

  const first = client.request('thread/resume', { threadId: 'thread-1' });
  const second = client.request('thread/read', { threadId: 'thread-2' });
  const resume = await waitForWrite(proc, 'thread/resume');
  const read = await waitForWrite(proc, 'thread/read');
  proc.stdout.write(`${JSON.stringify({ id: read.id, result: { thread: { id: 'thread-2' } } })}\n`);
  proc.stdout.write(`${JSON.stringify({ id: resume.id, result: { thread: { id: 'thread-1' } } })}\n`);

  assert.equal((await first).thread.id, 'thread-1');
  assert.equal((await second).thread.id, 'thread-2');
});

test('app-server client dispatches notifications and server requests', async (t) => {
  const proc = fakeProcess();
  const client = new CodexAppServerClient({
    bin: '/fake/codex',
    spawnFn: () => proc,
    requestTimeout: 1000,
  });
  t.after(() => client.stop());

  const started = client.start();
  const init = await waitForWrite(proc, 'initialize');
  proc.stdout.write(`${JSON.stringify({ id: init.id, result: {} })}\n`);
  await started;

  const notifications = [];
  const errors = [];
  const requests = [];
  client.on('item/agentMessage/delta', (params) => notifications.push(params));
  client.on('codexError', (params) => errors.push(params));
  client.on('serverRequest', (request) => requests.push(request));
  proc.stdout.write(`${JSON.stringify({
    method: 'item/agentMessage/delta',
    params: { threadId: 't', turnId: 'v', itemId: 'i', delta: 'hello' },
  })}\n`);
  proc.stdout.write(`${JSON.stringify({
    id: 99,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 't', turnId: 'v', itemId: 'i' },
  })}\n`);
  proc.stdout.write(`${JSON.stringify({
    method: 'error',
    params: {
      threadId: 't',
      turnId: 'v',
      error: { message: 'model failed' },
      willRetry: false,
    },
  })}\n`);

  assert.equal(notifications[0].delta, 'hello');
  assert.equal(errors[0].error.message, 'model failed');
  assert.equal(requests[0].id, 99);
  client.respond(99, { decision: 'decline' });
  assert.deepEqual(proc.writes.at(-1), { id: 99, result: { decision: 'decline' } });
});

test('concurrent starts share initialization before later requests are written', async (t) => {
  const proc = fakeProcess();
  const client = new CodexAppServerClient({
    bin: '/fake/codex',
    spawnFn: () => proc,
    requestTimeout: 1000,
  });
  t.after(() => client.stop());

  const first = client.request('thread/resume', { threadId: 'thread-1' });
  const second = client.request('thread/resume', { threadId: 'thread-2' });
  const init = await waitForWrite(proc, 'initialize');
  assert.deepEqual(proc.writes.map((message) => message.method), ['initialize']);

  proc.stdout.write(`${JSON.stringify({ id: init.id, result: {} })}\n`);
  const resumes = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    resumes.splice(0, resumes.length, ...proc.writes.filter((entry) =>
      entry.method === 'thread/resume'
    ));
    if (resumes.length === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(resumes.length, 2);
  for (const request of resumes) {
    proc.stdout.write(`${JSON.stringify({
      id: request.id,
      result: { thread: { id: request.params.threadId } },
    })}\n`);
  }
  assert.equal((await first).thread.id, 'thread-1');
  assert.equal((await second).thread.id, 'thread-2');
});
