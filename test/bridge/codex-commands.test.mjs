import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CODEX_MOBILE_FILTERED_COMMANDS,
  CODEX_MOBILE_COMMANDS,
  CODEX_TUI_COMMANDS,
  codexCommandCatalog,
  expandCodexLegacyPrompt,
  scanCodexLegacyPrompts,
} from '../../bridge/codex-commands.mjs';

function temporaryCodexHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpeek-codex-commands-'));
  fs.mkdirSync(path.join(home, 'prompts'), { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('Codex mobile catalog is the exact supported TUI-order intersection', () => {
  assert.equal(CODEX_TUI_COMMANDS.length, 44);
  assert.deepEqual(CODEX_TUI_COMMANDS.slice(0, 8).map((command) => command.name), [
    'model',
    'ide',
    'permissions',
    'keymap',
    'vim',
    'experimental',
    'approve',
    'memories',
  ]);
  assert.deepEqual(CODEX_MOBILE_COMMANDS.map((command) => command.name), [
    'model',
    'permissions',
    'experimental',
    'memories',
    'skills',
    'import',
    'hooks',
    'review',
    'rename',
    'new',
    'archive',
    'delete',
    'resume',
    'fork',
    'app',
    'init',
    'compact',
    'plan',
    'goal',
    'agent',
    'copy',
    'diff',
    'mention',
    'status',
    'mcp',
    'logout',
    'exit',
    'feedback',
    'ps',
    'stop',
    'clear',
    'personality',
    'subagents',
  ]);
  assert.equal(new Set(CODEX_MOBILE_COMMANDS.map((command) => command.name)).size, 33);
  assert.deepEqual(Object.keys(CODEX_MOBILE_FILTERED_COMMANDS), [
    'ide',
    'keymap',
    'vim',
    'approve',
    'side',
    'raw',
    'title',
    'statusline',
    'theme',
    'pets',
    'plugins',
  ]);
});

test('Codex catalog applies Bridge platform visibility without changing TUI order', () => {
  const mac = codexCommandCatalog({ codexHomes: [], platform: 'darwin' });
  const linux = codexCommandCatalog({ codexHomes: [], platform: 'linux' });
  assert.equal(mac.length, 33);
  assert.equal(linux.length, 32);
  assert.equal(mac.some((command) => command.name === 'app'), true);
  assert.equal(linux.some((command) => command.name === 'app'), false);
  assert.deepEqual(
    linux.map((command) => command.name),
    mac.filter((command) => command.name !== 'app').map((command) => command.name),
  );
});

test('Codex project catalog defers session-scoped picker options', () => {
  const catalog = codexCommandCatalog({
    codexHomes: [],
    commandOptions: {
      experimental: [{ name: 'feature', value: 'feature=on' }],
      agent: [{ name: 'thread-1', value: 'thread-1' }],
      subagents: [{ name: 'thread-1', value: 'thread-1' }],
    },
    remoteOptionNames: ['experimental', 'agent', 'subagents'],
  });
  for (const name of ['experimental', 'agent', 'subagents']) {
    const command = catalog.find((item) => item.name === name);
    assert.equal(command.optionsRemote, true);
    assert.deepEqual(command.options, []);
  }
  assert.equal(catalog.find((item) => item.name === 'model').optionsRemote, undefined);
});

test('legacy prompts are discovered after builtins in name order', (t) => {
  const home = temporaryCodexHome(t);
  fs.writeFileSync(path.join(home, 'prompts', 'z-last.md'), 'Last prompt');
  fs.writeFileSync(
    path.join(home, 'prompts', 'a-first.md'),
    '---\ndescription: "First prompt"\nargument-hint: NAME=value\n---\nHello $NAME',
  );
  fs.mkdirSync(path.join(home, 'prompts', 'ignored.md'));

  const prompts = scanCodexLegacyPrompts({ codexHomes: [home] });
  assert.deepEqual(prompts.map((prompt) => prompt.name), ['a-first', 'z-last']);
  assert.equal(prompts[0].description, 'First prompt');
  assert.equal(prompts[0].argumentHint, 'NAME=value');

  const catalog = codexCommandCatalog({ codexHomes: [home] });
  assert.deepEqual(
    catalog.slice(0, CODEX_MOBILE_COMMANDS.length).map((command) => command.name),
    CODEX_MOBILE_COMMANDS.map((command) => command.name),
  );
  assert.deepEqual(catalog.slice(CODEX_MOBILE_COMMANDS.length).map((command) => command.name), [
    'prompts:a-first',
    'prompts:z-last',
  ]);
  assert.equal(catalog[CODEX_MOBILE_COMMANDS.length].behavior, 'compose');
  assert.equal(catalog[CODEX_MOBILE_COMMANDS.length + 1].behavior, 'send');
});

test('legacy prompt expansion supports named and positional arguments', (t) => {
  const home = temporaryCodexHome(t);
  fs.writeFileSync(
    path.join(home, 'prompts', 'named.md'),
    'Review $TARGET for $OWNER. Keep $$LITERAL.',
  );
  fs.writeFileSync(
    path.join(home, 'prompts', 'positional.md'),
    'First=$1 Second=$2 All=$ARGUMENTS',
  );

  assert.equal(
    expandCodexLegacyPrompt(
      '/prompts:named TARGET="mobile app" OWNER=Wei',
      { codexHomes: [home] },
    ),
    'Review mobile app for Wei. Keep $$LITERAL.',
  );
  assert.equal(
    expandCodexLegacyPrompt(
      '/prompts:positional alpha "two words"',
      { codexHomes: [home] },
    ),
    'First=alpha Second=two words All=alpha two words',
  );
  assert.throws(
    () => expandCodexLegacyPrompt('/prompts:named TARGET=app', { codexHomes: [home] }),
    /Missing required args.*OWNER/,
  );
});
