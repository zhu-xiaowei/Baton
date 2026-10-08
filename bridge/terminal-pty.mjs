import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import pty from 'node-pty';

export const MAX_FRAME_BYTES = 28 * 1024;
let windowsShell = null;

export function dimensions(message) {
  if (!Number.isInteger(message.cols) || message.cols < 2 || message.cols > 500
    || !Number.isInteger(message.rows) || message.rows < 1 || message.rows > 200) {
    throw new Error('Invalid terminal dimensions (cols: 2–500, rows: 1–200)');
  }
  return { cols: message.cols, rows: message.rows };
}

export function inputBytes(data) {
  if (typeof data !== 'string' || !data.length || data.length > Math.ceil(4096 / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    throw new Error('Invalid base64 input');
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > 4096 || bytes.toString('base64') !== data) {
    throw new Error('Input exceeds 4 KiB or is not canonical base64');
  }
  return bytes;
}

export function defaultShell() {
  if (process.platform !== 'win32') {
    return { shell: userInfo().shell || process.env.SHELL || '/bin/bash', shellArgs: ['-l', '-i'] };
  }
  if (!windowsShell) {
    try {
      execFileSync('where.exe', ['pwsh.exe'], { stdio: 'ignore', windowsHide: true });
      windowsShell = 'pwsh.exe';
    } catch {
      windowsShell = 'powershell.exe';
    }
  }
  return { shell: windowsShell, shellArgs: ['-NoLogo'] };
}

export function spawnTerminal({ shell, shellArgs, cwd, cols, rows }) {
  if (process.platform === 'win32') return spawnWindowsTerminal({ shell, shellArgs, cwd, cols, rows });
  const environment = {};
  for (const key of ['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR']) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return pty.spawn(shell, shellArgs, {
    name: 'xterm-256color', cwd, cols, rows, encoding: null,
    env: { ...environment, SHELL: shell, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });
}

// ConPTY only emits utf8 strings and throws asynchronously on kill(signal);
// adapt it to the byte output and signal-tolerant kill the callers expect.
function spawnWindowsTerminal({ shell, shellArgs, cwd, cols, rows }) {
  const terminal = pty.spawn(shell, shellArgs, {
    name: 'xterm-256color', cwd, cols, rows,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });
  const onData = terminal.onData.bind(terminal);
  const kill = terminal.kill.bind(terminal);
  let killed = false;
  // onData is a getter-only accessor on the prototype, so shadow it on the instance.
  return Object.defineProperties(terminal, {
    onData: { value: listener => onData(data => listener(Buffer.from(data, 'utf8'))) },
    kill: { value: () => {
      if (killed) return;
      killed = true;
      kill();
    } },
  });
}
