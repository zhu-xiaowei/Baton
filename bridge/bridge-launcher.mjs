import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const UPDATE_EXIT_CODE = 75;
const bridgeHome = path.dirname(fileURLToPath(import.meta.url));
const bridgeEntry = path.join(bridgeHome, 'bridge.mjs');
let child;
let stopping = false;

function start() {
  child = spawn(process.execPath, [bridgeEntry], {
    cwd: bridgeHome,
    stdio: 'inherit',
    windowsHide: true,
  });
  child.once('exit', (code) => {
    child = null;
    if (!stopping && code === UPDATE_EXIT_CODE) {
      setTimeout(start, 1000);
      return;
    }
    process.exit(code ?? 1);
  });
}

function stop() {
  stopping = true;
  if (child) child.kill();
  else process.exit(0);
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);
start();
