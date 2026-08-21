import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  resolveRuntimeLauncher,
  runtimeLauncherError,
} from '../../bridge/runtime-launcher.mjs';
import { resolveClaudeBinForCapability } from '../../bridge/runtime-capabilities.mjs';

function shellFixture(root) {
  const zsh = '/bin/zsh';
  if (fs.existsSync(zsh)) {
    return {
      shell: zsh,
      initFile: path.join(root, '.zshrc'),
      env: { ZDOTDIR: root },
    };
  }
  const bash = '/bin/bash';
  return {
    shell: bash,
    initFile: path.join(root, '.bashrc'),
    env: { HOME: root },
  };
}

test('direct executable resolution wins without probing the user shell', () => {
  let probed = false;
  const resolved = resolveRuntimeLauncher('claude', ['/known/claude'], {
    allowShellFallback: true,
    findExecutableFn: () => '/known/claude',
    execFileSyncFn: () => { probed = true; },
  });

  assert.equal(resolved, '/known/claude');
  assert.equal(probed, false);
});

test('Claude shell fallback loads an interactive alias and preserves Bridge arguments', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-runtime-launcher-'));
  const binDir = path.join(root, 'bin');
  const fakeClaude = path.join(binDir, 'claude');
  const shell = shellFixture(root);
  fs.mkdirSync(binDir);
  fs.writeFileSync(fakeClaude, [
    '#!/bin/sh',
    'IFS= read -r input',
    'printf "BEDROCK=<%s>\\n" "$CLAUDE_CODE_USE_BEDROCK"',
    'printf "PROFILE=<%s>\\n" "$AWS_PROFILE"',
    'printf "STDIN=<%s>\\n" "$input"',
    'printf "ARG=<%s>\\n" "$@"',
    '',
  ].join('\n'), { mode: 0o700 });
  fs.writeFileSync(shell.initFile, [
    'printf "shell startup noise\\n"',
    `export PATH='${binDir}':"$PATH"`,
    'alias claude=\'CLAUDE_CODE_USE_BEDROCK=1 AWS_PROFILE=default command claude'
      + ' --model "global.anthropic.claude-opus-4-8[1m]"'
      + ' --dangerously-skip-permissions\'',
    '',
  ].join('\n'));

  const env = {
    ...process.env,
    ...shell.env,
    SHELL: shell.shell,
    PATH: '/usr/bin:/bin',
  };
  try {
    const launcher = resolveClaudeBinForCapability({
      home: root,
      bridgeHome: path.join(root, '.baton-bridge'),
      env,
      findExecutableFn: () => null,
    });
    const output = execFileSync(launcher, ['-p', '--resume', 'session-1'], {
      env,
      encoding: 'utf8',
      input: 'bridge message\n',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    assert.doesNotMatch(output, /shell startup noise/);
    assert.match(output, /BEDROCK=<1>/);
    assert.match(output, /PROFILE=<default>/);
    assert.match(output, /STDIN=<bridge message>/);
    assert.match(output, /ARG=<--model>/);
    assert.match(output, /ARG=<global\.anthropic\.claude-opus-4-8\[1m\]>/);
    assert.match(output, /ARG=<--dangerously-skip-permissions>/);
    assert.match(output, /ARG=<-p>/);
    assert.match(output, /ARG=<--resume>/);
    assert.match(output, /ARG=<session-1>/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Windows keeps direct resolution and does not probe PowerShell aliases', () => {
  let probed = false;
  const resolved = resolveRuntimeLauncher('claude', [], {
    platform: 'win32',
    allowShellFallback: true,
    env: { SHELL: 'powershell.exe', Path: 'C:\\Windows\\System32' },
    findExecutableFn: () => null,
    execFileSyncFn: () => { probed = true; },
  });

  assert.equal(resolved, null);
  assert.equal(probed, false);
});

test('launcher failure identifies checked binaries, PATH, and shell', () => {
  const error = runtimeLauncherError('claude', ['/opt/homebrew/bin/claude'], {
    env: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' },
  });

  assert.match(error.message, /Checked binaries: claude, \/opt\/homebrew\/bin\/claude/);
  assert.match(error.message, /PATH: \/usr\/bin:\/bin/);
  assert.match(error.message, /shell: \/bin\/zsh/);
});
