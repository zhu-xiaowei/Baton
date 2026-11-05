// Local-only fixtures for the installed Linux app's native WebDriver smoke test.
import https from 'node:https';
import fs from 'node:fs';
import { createHmac } from 'node:crypto';
import { WebSocketServer } from 'ws';

const origin = 'https://localhost:4443';
const device = 'linux-runner';
const projectHash = 'linux-smoke-project';
const sessionId = 'linux-smoke-session';
const now = new Date().toISOString();
const session = {
  sessionId, preview: 'Verify Linux desktop packaging / 验证 Linux 桌面',
  runtime: 'claude', status: 'completed', lastActive: now,
  messageCount: 2, model: 'claude-sonnet-4-6', size: 4096,
};
const project = {
  projectHash, projectName: 'Baton Linux', projectPath: '/home/runner/work/Baton',
  sessionCount: 2, runningCount: 1, lastActive: now, sessions: [session],
};
const devices = [{ deviceName: device, deviceDisplayName: 'Ubuntu Runner',
  online: true, os: 'linux', platform: 'linux', version: '1.1.0',
  lastActive: now, projectCount: 1, runningCount: 1, needsInputCount: 0,
  runtimes: [{ id: 'claude', available: true }] }];
const activeSession = { ...session, sessionId: 'linux-active-session',
  preview: 'Inspect Linux desktop rendering', status: 'running',
  deviceName: device, projectHash, projectName: project.projectName };
project.sessions.push(activeSession);
const files = [
  { name: 'src', type: 'directory' },
  { name: 'README.md', type: 'file' },
  { name: 'package.json', type: 'file' },
  { name: '中文说明.md', type: 'file' },
];
const readme = '# Baton Linux\n\nNative Linux desktop smoke test.\n\n'
  + '中文字体、Markdown、文件预览验证。\n\n'
  + '```js\nconsole.log("Hello from Ubuntu");\n```\n';
const repository = { branch: 'feat/linux-package', head: 'a'.repeat(40), unborn: false,
  detached: false, upstream: 'origin/main', ahead: 1, behind: 0 };
const server = https.createServer({
  cert: fs.readFileSync(process.argv[2]), key: fs.readFileSync(process.argv[3]),
}, async (request, response) => {
  const url = new URL(request.url, origin);
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'content-type,x-api-key');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
  console.log('HTTP', request.method, url.pathname);
  const routes = {
    '/api/bridge/devices': { devices },
    '/api/bridge/config': { wsUrl: origin.replace('https:', 'wss:') },
    '/api/bridge/active-sessions': { sessions: [activeSession], recentProjects: [{ ...project, deviceName: device }] },
    '/api/bridge/projects': { projects: [project], hasMore: false },
    '/api/bridge/sessions': { sessions: project.sessions, hasMore: false },
    '/api/bridge/session-threads': { threads: [], sessions: [] },
    '/api/bridge/messages': { status: 'completed', hasMore: false, messages: [
      { uuid: 'linux-user', type: 'user', content: session.preview, timestamp: now },
      { uuid: 'linux-assistant', type: 'assistant', timestamp: now,
        content: [{ type: 'text', text: '## Linux desktop verification\n\n'
          + 'The native app renders **Markdown**, tables, code and 中文 correctly.\n\n'
          + '| Check | Result |\n| --- | --- |\n| Native window | Running |\n| Files and Git | Ready |\n\n'
          + '```bash\nnpm run build:linux\n```\n\nLocal fixture data; no production account is used.' }] },
    ] },
    '/api/auth/start-token': { token: 'linux-smoke-token', expiresIn: 600 },
  };
  if (url.pathname in routes) {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(routes[url.pathname]));
  } else {
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: `No fixture for ${url.pathname}` }));
  }
});

const terminals = new Map();
const previews = new Map();
const frameKey = 'f'.repeat(64);
const websocket = new WebSocketServer({ server });
websocket.on('connection', socket => {
  socket.on('message', raw => {
    const message = JSON.parse(raw);
    console.log('WS', message.action, message.operation || message.op || '');
    const reply = fields => socket.send(JSON.stringify({ ...message, ok: true, ...fields }));
    if (message.action === 'heartbeat' || message.action === 'realtime_ping') {
      reply({ action: message.action === 'heartbeat' ? 'heartbeat' : 'realtime_pong' });
    } else if (message.action === 'project_files') {
      if (message.operation === 'list') {
        reply({ entries: message.path ? [{ name: 'main.js', type: 'file' }] : files, nextCursor: null });
      } else if (message.operation === 'read') {
        reply({ content: message.path.endsWith('.json') ? '{"name":"baton","version":"1.1.0"}' : readme });
      }
    } else if (message.action === 'git_status') {
      if (message.operation === 'status') {
        reply({ repository, snapshotId: 'linux-snapshot', stagedId: 'linux-staged',
          capabilities: { commit: 1, push: 1, history: 1 },
          groups: { conflicts: [], staged: [{ path: 'package.json', status: 'modified' }],
            changes: [{ path: 'README.md', status: 'modified' }, { path: 'src/main.js', status: 'untracked' }] } });
      } else if (message.operation === 'diff') {
        reply({ content: 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n'
          + '@@ -1,2 +1,3 @@\n # Baton\n-Desktop builds\n+Desktop builds for macOS, Windows and Linux\n+中文说明：支持 Linux\n',
        diffComplete: true });
      } else if (message.operation === 'history') {
        reply({ repository, commits: [
          { oid: 'a'.repeat(40), parents: ['b'.repeat(40)], subject: 'build: add Linux desktop package',
            authorName: 'Baton', authorTime: Math.floor(Date.now() / 1000), refs: [{ name: 'feat/linux-package', kind: 'branch', head: true }] },
          { oid: 'b'.repeat(40), parents: [], subject: 'Prepare desktop application',
            authorName: 'Baton', authorTime: Math.floor(Date.now() / 1000) - 3600, refs: [] },
        ], hasMore: false });
      } else if (message.operation === 'refs') {
        reply({ refs: [{ name: 'refs/heads/feat/linux-package', kind: 'branch' }] });
      }
    } else if (message.action === 'preview_tunnel' && message.op === 'open') {
      previews.set(message.tunnelId, { control: socket, message, streams: new Map() });
      reply({ type: 'offer', side: 'app', dataEndpoint: origin, joinToken: 'local-preview-fixture' });
    } else if (message.action === 'preview_tunnel' && message.op === 'join') {
      const preview = previews.get(message.tunnelId);
      preview.control.send(JSON.stringify({ ...preview.message, type: 'ready', side: 'app',
        endpoint: origin, region: 'us-east-1', connectionId: 'preview-app', peerConnectionId: 'preview-bridge',
        frameKey, credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture', sessionToken: 'fixture',
          expiresAt: Math.floor(Date.now() / 1000) + 3600 } }));
    } else if (message.action === 'preview_data') {
      const frame = JSON.parse(JSON.parse(message.body).payload);
      const preview = previews.get(frame.tunnelId);
      const input = frame.message;
      const send = fields => {
        const payload = JSON.stringify({ action: 'preview_frame', v: 1,
          tunnelId: frame.tunnelId, device, message: { streamId: input.streamId, ...fields } });
        socket.send(JSON.stringify({ payload, mac: createHmac('sha256', frameKey).update(payload).digest('hex') }));
      };
      if (input.type === 'open') {
        preview.streams.set(input.streamId, { headers: '', responded: false });
        send({ type: 'opened' });
      } else if (input.type === 'bytes') {
        const stream = preview.streams.get(input.streamId);
        stream.headers += Buffer.from(input.data, 'base64').toString();
        send({ type: 'ack', seq: input.seq });
        if (!stream.responded && stream.headers.includes('\r\n\r\n')) {
          stream.responded = true;
          const body = Buffer.from('<!doctype html><meta charset="utf-8"><title>Linux preview</title>'
            + '<style>body{font:18px system-ui;background:#eef5ff;color:#172a45;padding:48px}'
            + 'article{max-width:650px;background:white;padding:32px;border-radius:16px}'
            + 'code{background:#e8edf5;padding:4px 8px}</style>'
            + '<article><h1>Linux preview is running</h1><p>Loaded through the installed app’s native TCP proxy.</p>'
            + '<p>中文预览页面正常显示。</p><p><code>WebKitGTK · HTTP · local fixture</code></p></article>');
          const response = Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\n'
            + 'Content-Type: text/html; charset=utf-8\r\n'
            + `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`), body]);
          send({ type: 'bytes', seq: 1, data: response.toString('base64') });
          send({ type: 'fin', seq: 1 });
        }
      } else if (input.type === 'close') {
        preview.streams.delete(input.streamId);
      }
    } else if (message.action === 'terminal_direct' && message.op === 'open') {
      terminals.set(message.terminalId, { control: socket, message, sequence: 0 });
      reply({ type: 'offer', side: 'app', dataEndpoint: origin, joinToken: 'local-fixture', initialOpen: null });
    } else if (message.action === 'terminal_direct' && message.op === 'join') {
      const terminal = terminals.get(message.terminalId);
      terminal.socket = socket;
      terminal.control.send(JSON.stringify({ ...terminal.message, type: 'ready', side: 'app',
        endpoint: origin, region: 'us-east-1', connectionId: 'fixture-app', peerConnectionId: 'fixture-bridge',
        frameKey, credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture', sessionToken: 'fixture',
          expiresAt: Math.floor(Date.now() / 1000) + 3600 } }));
    } else if (message.action === 'terminal_direct_data') {
      const envelope = JSON.parse(message.body);
      const frame = JSON.parse(envelope.payload);
      const terminal = terminals.get(frame.terminalId);
      const input = frame.message;
      const send = fields => {
        const output = { action: 'terminal_shared', v: 1, device, projectHash,
          terminalId: frame.terminalId, eventSeq: ++terminal.sequence, ...fields };
        const payload = JSON.stringify({ action: 'terminal_direct_frame', v: 1,
          terminalId: frame.terminalId, device, message: output });
        socket.send(JSON.stringify({ payload, mac: createHmac('sha256', frameKey).update(payload).digest('hex') }));
      };
      if (input.type === 'open') {
        const screen = Buffer.from('\x1b[32mBaton Linux native terminal\x1b[0m\r\n'
          + 'Ubuntu runner · local test fixture\r\n中文显示正常\r\n$ npm run build:linux\r\n'
          + '  Linux DEB built successfully\r\n$ ');
        send({ type: 'sessions', limit: 5, sessions: [{ id: 'shell-1', name: 'Terminal 1' }] });
        send({ type: 'ready', sessionId: 'shell-1', name: 'Terminal 1', cwd: '/home/runner/work/Baton',
          epoch: 'epoch-1', snapshotId: 'snapshot-1', snapshotBytes: screen.length, snapshotChunks: 1,
          cols: input.cols || 100, rows: input.rows || 30, historyTruncated: false, exited: false });
        send({ type: 'snapshot', epoch: 'epoch-1', snapshotId: 'snapshot-1', index: 0, data: screen.toString('base64') });
        send({ type: 'synced', epoch: 'epoch-1', snapshotId: 'snapshot-1' });
      } else if (input.type === 'resize') {
        send({ type: 'resized', epoch: 'epoch-1', cols: input.cols, rows: input.rows });
      } else if (input.type === 'input') {
        send({ type: 'output', epoch: 'epoch-1', data: Buffer.from(input.data).toString('base64') });
      }
      if (input.clientSeq) {
        send({ type: 'ack', eventSeq: 0, clientSeq: input.clientSeq });
      }
    }
  });
});
server.listen(4443, '127.0.0.1', () => console.log('READY', origin));
