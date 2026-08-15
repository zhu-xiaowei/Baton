import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ClaudePool } from '../../bridge/headless.mjs';
import { scanSlashCommands } from '../../bridge/commands.mjs';
import {
  capturedClaudeCommandNames,
  claudeCommandCatalog,
  parseClaudeSlashCommand,
} from '../../bridge/claude-commands.mjs';

test('Claude catalog preserves TUI grouping while using live metadata and model order', () => {
  const commands = claudeCommandCatalog({
    commands: [
      {
        name: 'review-project',
        description: 'Review the project exactly as configured.',
        argumentHint: '[path]',
      },
      { name: 'model', description: 'Set model', argumentHint: '<model>' },
      {
        name: 'usage',
        description: 'Show session cost, plan usage, and limits',
        argumentHint: '',
        aliases: ['cost', 'stats'],
      },
      { name: 'effort', description: 'Set effort', argumentHint: '<low|high|auto>' },
      { name: 'fast', description: 'Toggle fast mode', argumentHint: '[on|off]' },
      { name: 'audit', description: '<!-- comment description -->', argumentHint: '' },
      { name: 'heapdump', description: 'Write a heap dump', argumentHint: '' },
      { name: '__remote-workflow', description: 'Internal', argumentHint: '' },
    ],
    models: [
      { value: 'default', displayName: 'Default', description: 'Use account default' },
      { value: 'opus', displayName: 'Opus', description: 'Most capable' },
    ],
    fast_mode_disabled_reason: 'Unavailable for this provider',
  });

  assert.deepEqual(commands.map((command) => command.name), [
    'effort',
    'model',
    'usage',
    'audit',
    'review-project',
  ]);
  assert.equal(commands.find((command) => command.name === 'audit').description,
    '<!-- comment description -->');
  assert.equal(commands.find((command) => command.name === 'review-project').argumentHint,
    '[path]');
  assert.deepEqual(
    commands.find((command) => command.name === 'model').options.map((option) => option.label),
    ['Default', 'Opus'],
  );
  assert.deepEqual(
    commands.find((command) => command.name === 'effort').options.map((option) => option.value),
    ['low', 'high', 'auto'],
  );
});

test('Claude command parser only captures supported synchronous local commands', () => {
  assert.deepEqual(parseClaudeSlashCommand('/model opus'), {
    name: 'model',
    args: 'opus',
    text: '/model opus',
  });
  assert.equal(parseClaudeSlashCommand('explain /model'), null);
  const captured = capturedClaudeCommandNames({
    commands: [
      { name: 'model', description: 'Set model', argumentHint: '<model>' },
      { name: 'compact', description: 'Summarize', argumentHint: '<optional custom summarization instructions>' },
      { name: 'review-project', description: 'Review', argumentHint: '' },
    ],
  });
  assert.equal(captured.has('model'), true);
  assert.equal(captured.has('compact'), false);
  assert.equal(captured.has('review-project'), false);
});

test('a custom command that shadows a builtin keeps prompt semantics', () => {
  const context = {
    commands: [{
      name: 'model',
      description: 'Custom model command (project)',
      argumentHint: '[target]',
    }],
    models: [{ value: 'default', displayName: 'Default' }],
  };
  assert.deepEqual(claudeCommandCatalog(context), [{
    name: 'model',
    source: 'runtime',
    description: 'Custom model command (project)',
    argumentHint: '[target]',
    aliases: [],
    behavior: 'compose',
  }]);
  assert.equal(capturedClaudeCommandNames(context).has('model'), false);
});

test('ClaudePool inspect reads initialize without persisting a session', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpeek-claude-inspect-'));
  const bin = path.join(root, 'fake-claude.mjs');
  const argvFile = path.join(root, 'argv.json');
  fs.writeFileSync(bin, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
fs.writeFileSync(process.env.ARGV_FILE, JSON.stringify(process.argv.slice(2)));
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type !== 'control_request' || message.request.subtype !== 'initialize') return;
  process.stdout.write(JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: message.request_id,
      response: {
        commands: [{ name: 'model', description: 'Set model', argumentHint: '<model>' }],
        models: [{ value: 'default', displayName: 'Default', description: 'Current default' }],
      },
    },
  }) + '\\n');
});
`);
  fs.chmodSync(bin, 0o755);

  const pool = new ClaudePool({
    bin,
    env: { ARGV_FILE: argvFile },
    initTimeout: 2000,
  });
  try {
    const result = await pool.inspect(root);
    assert.equal(result.commands[0].name, 'model');
    assert.equal(result.models[0].displayName, 'Default');
    assert.ok(JSON.parse(fs.readFileSync(argvFile, 'utf8')).includes('--no-session-persistence'));
  } finally {
    pool.shutdownAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('disk fallback keeps custom metadata and hides non-invocable skills', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpeek-claude-fallback-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const commands = path.join(project, '.claude', 'commands', 'nested');
  const visibleSkill = path.join(home, '.claude', 'skills', 'visible');
  const hiddenSkill = path.join(home, '.claude', 'skills', 'hidden');
  fs.mkdirSync(commands, { recursive: true });
  fs.mkdirSync(visibleSkill, { recursive: true });
  fs.mkdirSync(hiddenSkill, { recursive: true });
  fs.writeFileSync(path.join(commands, 'audit.md'),
    '\uFEFF---\r\ndescription: "Review target # exactly"\r\nargument-hint: [path]\r\n---\r\n# Ignored heading\r\n');
  fs.writeFileSync(path.join(project, '.claude', 'commands', 'heading.md'),
    '# Heading description\n\nPrompt body\n');
  fs.writeFileSync(path.join(visibleSkill, 'SKILL.md'),
    '---\nname: visible-skill\ndescription: >-\n  First description line\n  second description line\n---\nBody\n');
  fs.writeFileSync(path.join(hiddenSkill, 'SKILL.md'),
    '---\nname: hidden-skill\nuser-invocable: false\n---\nHidden\n');

  try {
    const result = scanSlashCommands(project, { home });
    assert.deepEqual(result.map((command) => command.name), [
      'heading',
      'nested:audit',
      'visible-skill',
    ]);
    assert.deepEqual(result.find((command) => command.name === 'nested:audit'), {
      name: 'nested:audit',
      source: 'project',
      description: 'Review target # exactly',
      argumentHint: '[path]',
      behavior: 'compose',
    });
    assert.equal(
      result.find((command) => command.name === 'heading').description,
      'Heading description',
    );
    assert.equal(
      result.find((command) => command.name === 'visible-skill').description,
      'First description line second description line',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
