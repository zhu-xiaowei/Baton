import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { removeServiceKeyArgs, uninstallBridge } from '../../bridge/config.mjs';

test('old service definitions stop passing the key; config.json is the only source', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-service-'));
  const plist = path.join(home, 'Library', 'LaunchAgents', 'com.baton.bridge.plist');
  const unit = path.join(home, '.config', 'systemd', 'user', 'baton-bridge.service');
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.mkdirSync(path.dirname(unit), { recursive: true });
  const program = [
    '  <key>ProgramArguments</key><array>',
    '    <string>/usr/bin/node</string>',
    '    <string>/Users/me/.baton-bridge/bridge.mjs</string>',
  ];
  fs.writeFileSync(plist, [...program,
    '    <string>--server</string><string>https://baton.test/v1</string>',
    '    <string>--key</string><string>secret</string>',
    '    <string>--name</string><string>mac</string>',
    '  </array>'].join('\n'));
  fs.writeFileSync(unit, '[Service]\nExecStart=/usr/bin/node /home/me/.baton-bridge/bridge.mjs --server https://baton.test/v1 --key secret --name box\nRestart=on-failure\n');
  const reloads = [];

  assert.equal(removeServiceKeyArgs({ platform: 'darwin', home }), true);
  assert.equal(fs.readFileSync(plist, 'utf-8'), [...program, '  </array>'].join('\n'));
  assert.equal(removeServiceKeyArgs({ platform: 'linux', home, exec: (...args) => reloads.push(args.slice(0, 2)) }), true);
  assert.equal(fs.readFileSync(unit, 'utf-8'), '[Service]\nExecStart=/usr/bin/node /home/me/.baton-bridge/bridge.mjs\nRestart=on-failure\n');
  assert.deepEqual(reloads, [['systemctl', ['--user', 'daemon-reload']]]);
  assert.equal(removeServiceKeyArgs({ platform: 'linux', home, exec: () => assert.fail('reloaded twice') }), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('a removed device turns off autostart and drops its key', () => {
  for (const [platform, service, commands] of [
    ['darwin', ['Library', 'LaunchAgents', 'com.baton.bridge.plist'], []],
    ['linux', ['.config', 'systemd', 'user', 'baton-bridge.service'],
      [['systemctl', ['--user', 'disable', 'baton-bridge']], ['systemctl', ['--user', 'daemon-reload']]]],
    ['win32', null, [['schtasks', ['/Delete', '/TN', 'Baton Bridge', '/F']]]],
  ]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-uninstall-'));
    const config = path.join(home, '.baton-bridge', 'config.json');
    const log = path.join(home, '.baton-bridge', 'bridge.log');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, '{"apiKey":"secret"}');
    fs.writeFileSync(log, 'kept');
    const file = service && path.join(home, ...service);
    if (file) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'service'); }
    const ran = [];

    uninstallBridge({ platform, home, exec: (command, args) => ran.push([command, args]) });
    assert.equal(fs.existsSync(config), false);
    assert.equal(fs.readFileSync(log, 'utf-8'), 'kept');
    if (file) assert.equal(fs.existsSync(file), false);
    assert.deepEqual(ran, commands);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
