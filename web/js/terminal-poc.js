import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import '../css/terminal-poc.css';
import { RemoteTerminalSocket } from './terminal-remote-transport.js';

const status = document.getElementById('status');
const container = document.getElementById('terminal');
const terminal = new Terminal({
  cursorBlink: true,
  fontSize: 14,
  fontFamily: 'Menlo, Monaco, monospace',
  scrollback: 3000,
  disableStdin: true,
  theme: { background: '#15171c', foreground: '#e4e7ef' },
});
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open(container);

function fitTerminal() {
  const size = fit.proposeDimensions();
  if (size) terminal.resize(Math.min(500, Math.max(2, size.cols)), Math.min(200, Math.max(1, size.rows)));
}

fitTerminal();
const query = new URLSearchParams(location.search);
const direct = query.get('transport') === 'direct';
const remote = direct || query.get('transport') === 'remote';
if (remote) document.querySelector('.notice').textContent = 'Remote WSS → Test Bridge → Local shell · Refresh starts a new session · Disconnect timeout: ~45s';
if (direct) document.querySelector('.notice').textContent = 'Header-signed WS → Test Bridge → Local PTY · Input/output bypass Lambda · Refresh starts a new session';
const socket = remote
  ? new RemoteTerminalSocket(query.get('device'), { profile: query.get('profile') === '1', direct })
  : new WebSocket('ws://127.0.0.1:8787/terminal-poc');
const encoder = new TextEncoder();
let ready = false;
let finalStatus = false;
let sequence = 0;
let pendingOutput = 0;

function stop(message) {
  ready = false;
  finalStatus = true;
  terminal.options.disableStdin = true;
  status.textContent = message;
  socket.close(1000, 'POC client stopped');
}

function send(message) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  const payload = JSON.stringify(message);
  if (socket.bufferedAmount + payload.length > 256 * 1024) {
    stop('Send queue full. Session stopped; refresh to start a new shell.');
    return false;
  }
  socket.send(payload);
  return true;
}

function sendInput(bytes) {
  if (!ready) return;
  if (bytes.length > 64 * 1024) {
    stop('Input exceeds 64 KiB. POC session stopped.');
    return;
  }
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    const data = btoa(String.fromCharCode(...bytes.subarray(offset, offset + 4096)));
    if (!send({ type: 'input', data })) break;
  }
}

terminal.onData(data => {
  if (!ready) return;
  sendInput(encoder.encode(data));
});
terminal.onBinary(data => {
  sendInput(Uint8Array.from(data, character => character.charCodeAt(0) & 255));
});
terminal.onResize(({ cols, rows }) => {
  if (ready) send({ type: 'resize', cols, rows });
});

socket.addEventListener('open', () => send({ type: 'open', cols: terminal.cols, rows: terminal.rows }));
socket.addEventListener('message', event => {
  try {
    if (typeof event.data !== 'string' || event.data.length > 28 * 1024) throw new Error('Invalid output frame');
    const message = JSON.parse(event.data);
    if (message.type === 'ready') {
      ready = true;
      terminal.options.disableStdin = false;
      status.textContent = `${direct ? 'Direct connection ready' : remote ? 'Remote connection ready' : 'Connected'} · ${message.shell} · ${message.cwd}`;
      fitTerminal();
      send({ type: 'resize', cols: terminal.cols, rows: terminal.rows });
      terminal.focus();
    } else if (message.type === 'output') {
      if (message.seq !== sequence + 1) throw new Error('Output sequence mismatch');
      sequence = message.seq;
      const bytes = Uint8Array.from(atob(message.data), character => character.charCodeAt(0));
      pendingOutput += bytes.length;
      if (pendingOutput > 1024 * 1024) throw new Error('Rendering queue exceeded 1 MiB');
      terminal.write(bytes, () => {
        pendingOutput -= bytes.length;
      });
    } else if (message.type === 'exit') {
      stop(`Shell exited (${message.exitCode}${message.signal ? `, signal ${message.signal}` : ''}) · Refresh to start a new session`);
    } else if (message.type === 'error') {
      stop(`Error: ${message.message}`);
    } else if (message.type !== 'resized') {
      throw new Error('Unknown server message');
    }
  } catch (error) {
    stop(`Terminal stopped: ${error.message}`);
  }
});
socket.addEventListener('error', event => stop(event.data || 'Connection failed. Run npm run poc:terminal and close other POC tabs.'));
socket.addEventListener('close', event => {
  ready = false;
  terminal.options.disableStdin = true;
  if (!finalStatus) status.textContent = `Disconnected (${event.code}) · Refresh for a new session; the old shell cannot be restored`;
});

const observer = new ResizeObserver(fitTerminal);
observer.observe(container);
window.addEventListener('pagehide', () => {
  observer.disconnect();
  socket.close(1000, 'Page closed');
  terminal.dispose();
}, { once: true });
