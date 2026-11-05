import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { BedrockModelConfig } from '../../bridge/bedrock-model-config.mjs';
import { CodexInteraction } from '../../bridge/codex-interaction.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-model-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = { active: false, goal: null, rejectResume: false, requests: [], contexts: [], calls: [] };
  class Client extends EventEmitter {
    generation = 1;
    async start() {}
    async stop() {}
    async request(method, params) {
      state.requests.push({ method, params });
      if (method === 'config/read') return { config: {
        model_provider: 'amazon-bedrock', model: 'openai.gpt-test-a', model_reasoning_effort: 'medium',
        model_providers: { 'amazon-bedrock': { aws: { region: 'us-west-2' } } },
      } };
      if (method === 'model/list') return { data: ['openai.gpt-test-a', 'openai.gpt-test-b', 'openai.hidden'].map(model => ({
        model, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], defaultReasoningEffort: 'medium',
      })) };
      if (method === 'thread/read') return { thread: { id: params.threadId, model: 'openai.gpt-test-a', status: { type: state.active ? 'active' : 'idle' } } };
      if (method === 'thread/goal/get') return { goal: state.goal };
      if (method === 'thread/unsubscribe') return { status: 'unsubscribed' };
      if (method === 'thread/resume') {
        if (state.rejectResume) throw new Error('already has an active writer');
        return { thread: { id: params.threadId, status: { type: 'idle' } }, model: 'openai.gpt-test-a' };
      }
      if (method === 'thread/settings/update') return {};
      if (method === 'turn/start') return { turn: { id: 'turn-test' } };
      if (method === 'thread/start') return { thread: { id: 'new' }, model: 'openai.gpt-test-b' };
      throw new Error('Unexpected method: ' + method);
    }
  }
  const factory = context => { state.contexts.push(context); return new Client(); };
  const service = new BedrockModelConfig({
    file: path.join(dir, 'settings.json'), clientFactory: factory,
    credentials: () => async () => ({ accessKeyId: 'test', secretAccessKey: 'test', sessionToken: 'temporary-test' }),
    fetch: async (url, options) => {
      state.calls.push({ url, options });
      if (url.endsWith('/models')) return { ok: true, json: async () => ({
        data: [
          { id: 'openai.gpt-test-a', status: 'available' },
          { id: 'openai.gpt-test-b', status: url.includes('us-east-1') ? 'available' : 'unavailable' },
          { id: 'openai.unknown', status: 'available' },
        ],
      }) };
      return { ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: 'OK' }] }] }) };
    },
  });
  const codex = new CodexInteraction({ clientFactory: factory, modelConfig: service,
    writerController: { describe: () => ({ canTerminate: false }) } });
  const base = { cwd: dir, sessionId: 'codex:s', nativeSessionId: 's', device: 'd',
    region: 'us-east-1', model: 'openai.gpt-test-b', effort: 'medium' };
  const verified = async (owner = 's') => ({ ...base, ...(await service.test(base, dir, owner)) });
  return { state, service, codex, base, verified };
}

test('catalog intersects region availability; signed requests cannot follow redirects', async t => {
  const { service, state, base } = fixture(t);
  assert.deepEqual((await service.catalog('us-west-2', base.cwd)).models.map(m => m.id), ['openai.gpt-test-a']);
  assert.deepEqual((await service.catalog('us-east-1', base.cwd)).models.map(m => m.id), ['openai.gpt-test-a', 'openai.gpt-test-b']);
  assert.match(state.calls[0].options.headers.authorization, /us-west-2\/bedrock\/aws4_request/);
  assert.equal(state.calls[0].options.redirect, 'error');
  await assert.rejects(service.catalog('https://example.invalid', base.cwd), /Unsupported/);
  await assert.rejects(service.test({ ...base, region: 'us-west-2' }, base.cwd, 's'), /available/);
});

test('static credentials and unsuccessful tests never produce receipts or settings', async t => {
  const { service, base } = fixture(t);
  service.credentials = () => async () => ({ accessKeyId: 'static-test', secretAccessKey: 'test-only' });
  await assert.rejects(service.catalog('us-east-1', base.cwd), /temporary/);
  assert.equal(service.tests.size, 0);
  assert.equal(service.defaultSettings(), null);
});

test('test receipts bind the session, working directory and selection and expire', async t => {
  const { service, base, verified } = fixture(t);
  const receipt = await verified();
  assert.equal(service.receipt(receipt.testId, base.cwd, 's').region, 'us-east-1');
  assert.throws(() => service.receipt(receipt.testId, base.cwd, 'other'), /Test this/);
  assert.throws(() => service.receipt(receipt.testId, '/different', 's'), /Test this/);
  assert.throws(() => service.checked({ ...receipt, effort: 'high' }, base.cwd, 's'), /Test this/);
  service.tests.get(receipt.testId).until = 0;
  assert.throws(() => service.receipt(receipt.testId, base.cwd, 's'), /Test this/);
});

test('saving a region acquires no writer; only the selected session uses it on resume', async t => {
  const { service, codex, state, base, verified } = fixture(t);
  t.after(() => codex.shutdown());
  const receipt = await verified();
  const result = await codex.runCommand({ ...base, name: 'model', args: `apply-region ${receipt.testId}` });
  assert.match(result.output, /next turn/);
  assert.equal(service.saved('s').region, 'us-east-1');
  assert.equal(service.saved('other'), null);
  assert.equal(service.defaultSettings(), null);
  assert.equal(state.requests.some(r => r.method === 'thread/resume'), false);
  await codex.sendExisting({ ...base, streamId: 'test', text: 'hello', callbacks: {} });
  const resume = state.requests.find(r => r.method === 'thread/resume');
  assert.equal(resume.params.model, 'openai.gpt-test-b');
  assert.equal(resume.params.config.model_reasoning_effort, 'medium');
  assert.ok(state.contexts.some(c => c.configOverrides?.['model_providers.amazon-bedrock.aws.region'] === 'us-east-1'));
});

test('active turns, Goals and disk failures leave preferences unchanged', async t => {
  const { service, codex, state, base, verified } = fixture(t);
  const receipt = await verified();
  const options = { ...base, name: 'model', args: `apply-region ${receipt.testId} default` };
  state.active = true;
  await assert.rejects(codex.runCommand(options), /Stop the current/);
  state.active = false;
  state.goal = { status: 'active' };
  await assert.rejects(codex.runCommand(options), /Stop the current/);
  state.goal = null;
  service.save = () => { throw new Error('Disk full'); };
  await assert.rejects(codex.runCommand(options), /Disk full/);
  assert.equal(service.defaultSettings(), null);
  assert.equal(service.saved('s'), null);
  assert.equal(codex.sessions.get('s').bedrock, null);
});

test('defaults survive reload and apply only to newly created threads', async t => {
  const { service, codex, state, base, verified } = fixture(t);
  t.after(() => codex.shutdown());
  const receipt = await verified();
  await codex.runCommand({ ...base, name: 'model', args: `apply-region ${receipt.testId} default` });
  const reloaded = new BedrockModelConfig({ file: service.file });
  assert.equal(reloaded.defaultSettings().region, 'us-east-1');
  if (process.platform !== 'win32') assert.equal(fs.statSync(service.file).mode & 0o777, 0o600);
  await codex.create({ cwd: base.cwd, text: 'hello', streamId: 'new-test', callbacks: {} });
  assert.equal(service.saved('new').region, 'us-east-1');
  assert.equal(service.saved('other'), null);
  assert.ok(state.contexts.some(c => c.configOverrides?.model === 'openai.gpt-test-b'));
  await codex.runCommand({ ...base, name: 'model', args: 'region clear-default' });
  assert.equal(service.defaultSettings(), null);
  assert.equal(service.saved('s').region, 'us-east-1');
});

test('a normal model change rolls back native settings if preference persistence fails', async t => {
  const { service, codex, state, base } = fixture(t);
  service.save('s', { region: 'us-west-2', model: 'openai.gpt-test-a', effort: 'medium' });
  service.save = () => { throw new Error('Disk full'); };
  await assert.rejects(codex.runCommand({ ...base, name: 'model', args: 'openai.gpt-test-b medium' }), /Disk full/);
  assert.deepEqual(state.requests.filter(r => r.method === 'thread/settings/update').map(r => r.params.model),
    ['openai.gpt-test-b', 'openai.gpt-test-a']);
  assert.equal(service.saved('s').model, 'openai.gpt-test-a');
});
