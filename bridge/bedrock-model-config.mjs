import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { CodexAppServerClient } from './codex-app-server.mjs';

export const MODEL_REGIONS = ['us-west-2', 'us-east-1'];
export const regionOverrides = region => ({
  'model_provider': 'amazon-bedrock',
  'model_providers.amazon-bedrock.aws.region': region,
});

export class BedrockModelConfig {
  constructor(options = {}) {
    this.file = options.file || path.join(os.homedir(), '.baton-bridge', 'bedrock-model-config.json');
    this.clientFactory = options.clientFactory || (context => new CodexAppServerClient(context));
    this.credentials = options.credentials || (profile => fromNodeProviderChain(profile ? { profile } : {}));
    this.fetch = options.fetch || globalThis.fetch;
    this.tests = new Map();
    this.catalogs = new Map();
    this.inflight = new Map();
  }

  load() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { sessions: {} }; throw error; }
  }

  saved(id) { return this.load().sessions?.[id] || null; }
  defaultSettings() { return this.load().default || null; }

  save(id, value, makeDefault = false) {
    const data = this.load();
    data.sessions ||= {};
    if (id) data.sessions[id] = value;
    if (makeDefault) data.default = value;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } finally { fs.rmSync(temp, { force: true }); }
  }

  async config(cwd) {
    const client = this.clientFactory({ cwd });
    try {
      await client.start();
      const { config } = await client.request('config/read', { cwd, includeLayers: false });
      if (config?.model_provider !== 'amazon-bedrock') throw new Error('This Codex configuration does not use Amazon Bedrock.');
      const aws = config.model_providers?.['amazon-bedrock']?.aws || {};
      if (!MODEL_REGIONS.includes(aws.region)) throw new Error('Configure an explicit supported Bedrock region on the Bridge first.');
      return {
        region: aws.region, model: config.model, effort: config.model_reasoning_effort ?? null,
        profile: aws.profile || null,
      };
    } finally { await client.stop(); }
  }

  async signed(region, profile, endpoint, body) {
    if (!MODEL_REGIONS.includes(region)) throw new Error('Unsupported Bedrock region.');
    const credentials = await this.credentials(profile)();
    if (!credentials.sessionToken) throw new Error('Use existing role or SSO temporary credentials; static keys are not supported.');
    const hostname = `bedrock-mantle.${region}.api.aws`;
    const payload = body ? JSON.stringify(body) : undefined;
    const signer = new SignatureV4({ credentials, region, service: 'bedrock', sha256: Sha256 });
    const req = await signer.sign({
      method: body ? 'POST' : 'GET', protocol: 'https:', hostname, path: endpoint,
      headers: { host: hostname, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(payload ? { body: payload } : {}),
    });
    const response = await this.fetch(`https://${hostname}${endpoint}`, {
      method: req.method, headers: req.headers, body: payload, signal: AbortSignal.timeout(45000), redirect: 'error',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Bedrock ${response.status}: ${String(data.error?.message || data.message || 'Request failed').slice(0, 300)}`);
    return data;
  }

  async catalog(region, cwd) {
    if (!MODEL_REGIONS.includes(region)) throw new Error('Unsupported Bedrock region.');
    const config = await this.config(cwd);
    const key = JSON.stringify([cwd, region, config.profile]);
    const cached = this.catalogs.get(key);
    if (cached && cached.until > Date.now()) return cached.value;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const request = (async () => {
      const client = this.clientFactory({ cwd, configOverrides: regionOverrides(region) });
      try {
        await client.start();
        const actual = await this.signed(region, config.profile, '/v1/models');
        const ids = new Set((actual.data || []).filter(m => m.status === 'available').map(m => m.id));
        const models = [];
        let cursor = null;
        do {
          const page = await client.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
          for (const m of page.data || []) {
            if (!ids.has(m.model) || !m.model.startsWith('openai.gpt-') || m.hidden) continue;
            models.push({
              id: m.model, label: m.displayName || m.model,
              efforts: (m.supportedReasoningEfforts || []).map(e => e.reasoningEffort),
              defaultEffort: m.defaultReasoningEffort ?? null,
            });
          }
          cursor = page.nextCursor || null;
        } while (cursor);
        const value = { region, models, regions: MODEL_REGIONS };
        this.catalogs.set(key, { until: Date.now() + 60000, value });
        return value;
      } finally { await client.stop(); }
    })();
    this.inflight.set(key, request);
    try { return await request; } finally { this.inflight.delete(key); }
  }

  async test(selection, cwd, owner) {
    const { region, model, effort } = selection;
    const catalog = await this.catalog(region, cwd);
    const entry = catalog.models.find(m => m.id === model);
    if (!entry || !entry.efforts.includes(effort)) throw new Error('Choose a model and reasoning effort available in this region.');
    const config = await this.config(cwd);
    const started = Date.now();
    const prefix = model.includes('gpt-oss') ? '/v1' : '/openai/v1';
    const data = await this.signed(region, config.profile, `${prefix}/responses`, {
      model, input: 'Reply with exactly OK.', reasoning: { effort }, max_output_tokens: 512, store: false,
    });
    const text = (data.output || []).flatMap(item => item.content || [])
      .filter(c => c.type === 'output_text').map(c => c.text).join('');
    if (data.status !== 'completed' || text.trim() !== 'OK') throw new Error('The connection test did not complete successfully. Retry or choose another model.');
    for (const [key, value] of this.tests) if (value.until < Date.now()) this.tests.delete(key);
    if (this.tests.size >= 100) this.tests.delete(this.tests.keys().next().value);
    const testId = randomUUID();
    this.tests.set(testId, { owner, cwd, region, model, effort, until: Date.now() + 300000 });
    return { testId, milliseconds: Date.now() - started, region, model, effort };
  }

  receipt(testId, cwd, owner) {
    const value = this.tests.get(testId);
    return this.checked({ ...value, testId }, cwd, owner);
  }

  checked(options, cwd, owner) {
    const value = this.tests.get(options.testId);
    if (!value || value.until < Date.now() || value.owner !== owner || value.cwd !== cwd
      || ['region', 'model', 'effort'].some(k => value[k] !== options[k])) {
      throw new Error('Test this selection first. Test receipts expire after five minutes.');
    }
    return { region: value.region, model: value.model, effort: value.effort };
  }
}
