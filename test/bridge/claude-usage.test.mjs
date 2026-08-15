import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ClaudePool } from '../../bridge/headless.mjs';
import {
  buildClaudeUsagePanel,
  scanClaudeStats,
} from '../../bridge/claude-usage.mjs';

function writeRows(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => (
    typeof row === 'string' ? row : JSON.stringify(row)
  )).join('\n') + '\n');
}

test('Claude stats aggregates sessions, dates, and model usage without double counting', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-claude-stats-'));
  const projects = path.join(root, 'projects');
  const first = path.join(projects, 'project-a', 'session-a.jsonl');
  const duplicate = path.join(projects, 'project-b', 'session-a.jsonl');
  const second = path.join(projects, 'project-a', 'session-b.jsonl');
  const assistant = {
    type: 'assistant',
    uuid: 'assistant-a',
    sessionId: 'session-a',
    timestamp: '2026-08-01T01:00:00.000Z',
    message: {
      model: 'model-opus',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 2,
      },
    },
  };

  writeRows(first, [
    { type: 'user', uuid: 'user-a', sessionId: 'session-a', timestamp: '2026-08-01T00:00:00.000Z' },
    assistant,
    { type: 'user', uuid: 'user-a2', sessionId: 'session-a', timestamp: '2026-08-02T00:00:00.000Z' },
    '{bad json',
  ]);
  writeRows(duplicate, [assistant]);
  writeRows(second, [{
    type: 'assistant',
    uuid: 'assistant-b',
    sessionId: 'session-b',
    timestamp: '2026-08-03T00:00:00.000Z',
    message: {
      model: 'model-sonnet',
      usage: { input_tokens: 20, output_tokens: 7 },
    },
  }]);
  writeRows(path.join(projects, 'project-a', 'empty.jsonl'), [
    { type: 'mode', mode: 'normal', sessionId: 'empty' },
  ]);

  try {
    const stats = scanClaudeStats({
      projectsRoot: projects,
      now: new Date('2026-08-03T12:00:00.000Z'),
      useCache: false,
    });
    const all = stats.ranges.find((range) => range.key === 'all');
    assert.equal(stats.filesScanned, 4);
    assert.equal(stats.malformedLines, 1);
    assert.equal(all.summary.sessions, 2);
    assert.equal(all.summary.activeDays, 3);
    assert.equal(all.summary.totalTokens, 47);
    assert.equal(all.summary.longestSessionMs, 86_400_000);
    assert.deepEqual(
      all.models.map((model) => [model.id, model.total]),
      [['model-sonnet', 27], ['model-opus', 20]],
    );
    assert.equal(all.modelChart.unit, 'month');
    assert.deepEqual(all.modelChart.labels, ['2026-08']);
    assert.deepEqual(
      all.modelChart.series.map((series) => [series.id, series.values]),
      [['model-sonnet', [27]], ['model-opus', [20]]],
    );
    const last7 = stats.ranges.find((range) => range.key === '7d');
    assert.equal(last7.modelChart.unit, 'day');
    assert.equal(last7.modelChart.labels.length, 7);
    assert.deepEqual(last7.modelChart.labels.slice(-3), [
      '2026-08-01',
      '2026-08-02',
      '2026-08-03',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Claude usage panel uses live controls and redacts sensitive config values', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-claude-panel-'));
  const projects = path.join(root, 'projects');
  const filePath = path.join(projects, 'project', 'session.jsonl');
  writeRows(filePath, [{
    type: 'assistant',
    uuid: 'assistant',
    sessionId: 'session',
    timestamp: '2026-08-15T01:00:00.000Z',
    version: '2.1.233',
    cwd: '/workspace/project',
    message: {
      model: 'model-opus',
      usage: { input_tokens: 8, output_tokens: 3 },
    },
  }]);

  const pool = {
    async inspectSession() {
      return {
        errors: {},
        result: {
          initialize: {
            current_permission_mode: 'manual',
            fast_mode_state: 'off',
            output_style: 'default',
            pid: 1234,
            agents: [{ name: 'reviewer' }],
            account: { apiProvider: 'bedrock' },
            models: [{
              value: 'opus',
              resolvedModel: 'model-opus',
              displayName: 'Opus',
            }],
          },
          get_settings: {
            applied: { model: 'model-opus', effort: 'high' },
            effective: {
              theme: 'dark',
              apiKey: 'should-not-leak',
              env: { SAFE_NAME: 'visible-name', PRIVATE_TOKEN: 'secret' },
            },
            sources: [{
              source: 'userSettings',
              settings: { password: 'secret', theme: 'dark' },
            }],
          },
          get_usage: {
            session: {
              total_cost_usd: 1.25,
              total_api_duration_ms: 2000,
              total_duration_ms: 3000,
              model_usage: {},
            },
          },
        },
      };
    },
  };

  try {
    const panel = await buildClaudeUsagePanel({
      pool,
      sessionId: 'session',
      cwd: '/workspace/project',
      filePath,
      projectsRoot: projects,
      initialTab: 'stats',
    });
    assert.equal(panel.initialTab, 'stats');
    assert.equal(panel.status.items.find((item) => item.label === 'Model').value, 'Opus');
    assert.equal(panel.status.items.find((item) => item.label === 'API connectivity').value,
      'Connected');
    assert.equal(panel.status.items.find((item) => item.label === 'Available agents').value, 1);
    assert.equal(panel.usage.items.find((item) => item.label === 'Input tokens').value, 8);
    assert.equal(panel.stats.ranges[0].models[0].label, 'Opus');
    assert.equal(panel.stats.ranges[0].modelChart.series[0].label, 'Opus');
    assert.doesNotMatch(JSON.stringify(panel), /should-not-leak|PRIVATE_TOKEN\":\"secret|password\":\"secret/);
    assert.match(JSON.stringify(panel), /••••/);
    assert.ok(Buffer.byteLength(JSON.stringify(panel)) < 30_000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Claude usage panel stays within the WebSocket transport budget', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-claude-panel-large-'));
  const projects = path.join(root, 'projects');
  const huge = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [
    `setting${index}`,
    'x'.repeat(2000),
  ]));
  const pool = {
    async inspectSession() {
      return {
        errors: {},
        result: {
          initialize: { commands: [], models: [] },
          get_settings: {
            applied: huge,
            effective: huge,
            sources: Array.from({ length: 20 }, (_, index) => ({
              source: `source${index}`,
              settings: huge,
            })),
          },
          get_usage: {},
        },
      };
    },
  };

  try {
    const panel = await buildClaudeUsagePanel({
      pool,
      sessionId: 'session',
      cwd: root,
      projectsRoot: projects,
    });
    const rawText = panel.rawText;
    delete panel.rawText;
    assert.equal(panel.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(panel)) <= 23_000);
    assert.ok(Buffer.byteLength(JSON.stringify({
      commandPanel: panel,
      commandOutput: rawText,
    })) < 32_000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ClaudePool inspectSession requests live session controls without persistence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-claude-session-inspect-'));
  const bin = path.join(root, 'fake-claude.mjs');
  const argvFile = path.join(root, 'argv.json');
  fs.writeFileSync(bin, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
fs.writeFileSync(process.env.ARGV_FILE, JSON.stringify(process.argv.slice(2)));
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type !== 'control_request') return;
  process.stdout.write(JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: message.request_id,
      response: { subtype: message.request.subtype },
    },
  }) + '\\n');
});
`);
  fs.chmodSync(bin, 0o755);

  const pool = new ClaudePool({
    bin,
    env: { ARGV_FILE: argvFile },
    initTimeout: 5000,
  });
  try {
    const response = await pool.inspectSession(
      '11111111-1111-4111-8111-111111111111',
      root,
      ['initialize', 'get_settings', 'get_usage'],
    );
    assert.deepEqual(Object.keys(response.result), ['initialize', 'get_settings', 'get_usage']);
    const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
    assert.ok(argv.includes('--resume'));
    assert.ok(argv.includes('11111111-1111-4111-8111-111111111111'));
    assert.ok(argv.includes('--no-session-persistence'));
  } finally {
    pool.shutdownAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
