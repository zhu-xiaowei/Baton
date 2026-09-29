#!/usr/bin/env node
// Xcode Cloud: stand in for the options server `tauri ios build` normally runs, then exec `tauri ios xcode-script`.
// Usage: node tauri-options.mjs <command...>

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const here = path.dirname(new URL(import.meta.url).pathname);
const tauriConf = JSON.parse(fs.readFileSync(path.join(here, '../../../tauri.conf.json'), 'utf8'));
// Same defaults `tauri ios build` sends when no --features/--config/args are given (tauri-cli CliOptions).
const options = { dev: false, features: [], args: [], noise_level: 'Polite', vars: {}, config: [], target_device: null };

const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    const req = JSON.parse(raw.toString());
    const res = req.method === 'options'
      ? { jsonrpc: '2.0', id: req.id, result: options }
      : { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } };
    ws.send(JSON.stringify(res));
  });
});

wss.on('listening', () => {
  const addrFile = path.join(os.tmpdir(), `${tauriConf.identifier}-server-addr`);
  fs.writeFileSync(addrFile, `127.0.0.1:${wss.address().port}`);
  const [cmd, ...args] = process.argv.slice(2);
  const child = spawn(cmd, args, { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    fs.rmSync(addrFile, { force: true });
    wss.close();
    process.exit(signal ? 1 : code);
  });
});
