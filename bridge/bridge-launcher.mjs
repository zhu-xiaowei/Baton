import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const UPDATE_EXIT_CODE = 75;
const bridgeHome = path.dirname(fileURLToPath(import.meta.url));
const bridgeEntry = path.join(bridgeHome, 'bridge.mjs');
let child;
let stopping = false;
let restartTimer;

function start() {
  restartTimer = null;
  if (stopping) return;
  child = spawn(process.execPath, [bridgeEntry], {
    cwd: bridgeHome,
    stdio: 'inherit',
    windowsHide: true,
  });
  child.once('error', error => console.error(`[launcher] ${error.message}`));
  child.once('close', (code, signal) => {
    child = null;
    if (!stopping && code !== 0) {
      const delay = code === UPDATE_EXIT_CODE ? 1000 : 5000;
      console.log(`[launcher] Bridge exited (${signal || code}); restarting in ${delay}ms`);
      restartTimer = setTimeout(start, delay);
      return;
    }
    process.exit(stopping ? 0 : code ?? 1);
  });
}

function stop() {
  stopping = true;
  clearTimeout(restartTimer);
  if (child) child.kill();
  else process.exit(0);
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);
start();
