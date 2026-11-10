import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BRIDGE_HOME } from './config.mjs';

const run = promisify(execFile);

// Native IDs of sessions Baton has sent to or driven; their alerts keep the old behavior.
export const batonSessions = new Set();
// Baton's own remote terminals: their input comes from the phone, not the computer.
export const batonTtys = new Set();

let pending = null;

// Seconds since the user last typed in any of their terminals or used the mouse/keyboard,
// or null when unknown or the screen is locked. Lets the server skip alerts for local turns.
export function localIdleSec() {
  pending ??= measure().finally(() => { pending = null; });
  return pending;
}

async function measure() {
  try {
    const idle = [ttyIdleSec()];
    if (process.platform === 'darwin') idle.push(await macIdleSec());
    if (process.platform === 'win32') idle.push(await windowsIdleSec());
    const known = idle.filter(Number.isFinite);
    return known.length ? Math.round(Math.min(...known)) : null;
  } catch {
    return null;
  }
}

// A pty's atime moves only when its reader (a shell or TUI) consumes typed input.
export function ttyIdleSec(dir = process.platform === 'darwin' ? '/dev' : '/dev/pts') {
  if (process.platform === 'win32') return null;
  let last = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch {}
  for (const name of names) {
    const file = path.join(dir, name);
    if ((dir === '/dev' && !/^ttys\d+$/.test(name)) || batonTtys.has(file)) continue;
    try {
      const stat = fs.statSync(file);
      if (stat.uid === process.getuid()) last = Math.max(last, stat.atimeMs);
    } catch {}
  }
  return last ? (Date.now() - last) / 1000 : null;
}

async function macIdleSec() {
  const { stdout: root } = await run('ioreg', ['-n', 'Root', '-d1'], { timeout: 3000 });
  if (root.includes('"CGSSessionScreenIsLocked"=Yes')) throw new Error('locked');
  const { stdout } = await run('ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { timeout: 3000 });
  const ns = /"HIDIdleTime" = (\d+)/.exec(stdout)?.[1];
  return ns ? Number(ns) / 1e9 : null;
}

// Bridge runs as SYSTEM/S4U in session 0, which cannot see the user's input, so an
// Interactive task runs a hidden helper in the console user's session.
const WIN_HELPER = String.raw`Add-Type 'using System;using System.Runtime.InteropServices;public static class I{struct L{public uint s;public uint t;}[DllImport("user32.dll")]static extern bool GetLastInputInfo(ref L l);public static uint Ms(){var l=new L();l.s=8;GetLastInputInfo(ref l);return unchecked((uint)Environment.TickCount-l.t);}}'
[IO.File]::WriteAllText($args[0], [I]::Ms())`;

async function windowsIdleSec() {
  const ps1 = path.join(BRIDGE_HOME, 'presence.ps1');
  const vbs = path.join(BRIDGE_HOME, 'presence.vbs');
  const out = path.join(BRIDGE_HOME, 'presence.txt');
  fs.writeFileSync(ps1, WIN_HELPER);
  fs.writeFileSync(vbs, `CreateObject("WScript.Shell").Run "powershell -NoProfile -ExecutionPolicy Bypass -File ""${ps1}"" ""${out}""", 0, True`);
  fs.rmSync(out, { force: true });
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$u = (Get-CimInstance Win32_ComputerSystem).UserName; if (-not $u) { exit 1 }
Register-ScheduledTask -TaskName 'Baton Presence' -Force -Action (New-ScheduledTaskAction -Execute wscript.exe -Argument '"${vbs.replaceAll("'", "''")}"') -Principal (New-ScheduledTaskPrincipal -UserId $u -LogonType Interactive) | Out-Null
Start-ScheduledTask -TaskName 'Baton Presence'`], { timeout: 15000, windowsHide: true });
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
    if (text) return Number(text) / 1000;
  }
  return null;
}
