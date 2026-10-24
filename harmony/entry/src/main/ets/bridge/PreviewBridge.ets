import { webview } from '@kit.ArkWeb';
import { BusinessError } from '@kit.BasicServicesKit';
import { socket } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';

// Injected into the webview as window.harmonyPreviewBridge. It is the HarmonyOS
// counterpart of src-tauri/src/preview_proxy.rs: the local half of Remote
// preview. The frontend (web/js/preview-native.js → preview-transport.js) owns
// the tunnel to the Bridge; this file only owns the loopback listener the
// preview iframe connects to, and the byte plumbing between that socket and the
// tunnel. Commands arrive as JSON (an id is answered through
// window.__onHarmonyPreview {event:'result'}); accepted sockets, their bytes,
// fin and close are pushed through the same callback.
//
// Same limits as the Tauri proxy: 16 KB chunks, a 128 KB per-stream window,
// 24 streams per tunnel, 4 tunnels, and 512 KB of queued browser bytes.
//
// Two deliberate differences, both forced by the ArkTS socket API:
//   - on('message') pushes bytes with no way to pause the read, so the credit
//     window is enforced on an application-level queue instead of on the read.
//   - TCPSocketConnection has no shutdown(Write), so a remote FIN flushes the
//     queued writes and closes the whole connection (see halfClose).

const LOOPBACK: string = '127.0.0.1';
const CHUNK_BYTES: number = 16 * 1024;
const WINDOW_BYTES: number = 128 * 1024;
const MAX_PENDING_BYTES: number = 512 * 1024;
const MAX_STREAMS: number = 24;
const MAX_TUNNELS: number = 4;
const MAX_PORT_ATTEMPTS: number = 16;
const UUID: RegExp = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A class, not an interface: ArkTS only casts parsed JSON onto a declared class.
class PreviewArgs {
  id: number = 0;
  tunnelId: string = '';
  preferredPort: number = 0;
  streamId: string = '';
  data: string = '';
  bytes: number = 0;
}

class PreviewStream {
  tunnelId: string;
  streamId: string;
  connection: socket.TCPSocketConnection;
  queue: Uint8Array[] = [];
  queuedBytes: number = 0;
  credit: number = 0;
  seq: number = 0;
  // The peer closed its side; the fin event waits until the queue has drained so
  // the frontend never sees a fin ahead of the bytes it covers.
  finPending: boolean = false;
  finSent: boolean = false;
  closed: boolean = false;
  writes: Promise<void> = Promise.resolve();

  constructor(tunnelId: string, streamId: string, connection: socket.TCPSocketConnection) {
    this.tunnelId = tunnelId;
    this.streamId = streamId;
    this.connection = connection;
  }
}

class PreviewSession {
  tunnelId: string;
  port: number;
  server: socket.TCPSocketServer;
  streams: Set<string> = new Set<string>();
  stopped: boolean = false;

  constructor(tunnelId: string, port: number, server: socket.TCPSocketServer) {
    this.tunnelId = tunnelId;
    this.port = port;
    this.server = server;
  }
}

const base64: util.Base64Helper = new util.Base64Helper();

function parseArgs(argsJson: string): PreviewArgs | null {
  try {
    return JSON.parse(argsJson) as PreviewArgs;
  } catch (e) {
    return null;
  }
}

function localOrigin(port: number): string {
  return `http://${LOOPBACK}:${port}`;
}

function closeServer(server: socket.TCPSocketServer): void {
  server.close().catch((error: BusinessError) => {
    console.info(`baton preview listener cleanup: ${error.code}`);
  });
}

function closeConnection(connection: socket.TCPSocketConnection): void {
  connection.close().catch((error: BusinessError) => {
    console.info(`baton preview socket cleanup: ${error.code}`);
  });
}

function detach(connection: socket.TCPSocketConnection): void {
  try {
    connection.off('message');
    connection.off('close');
    connection.off('error');
  } catch (e) {
    // Already gone; nothing is subscribed.
  }
}

export class PreviewBridge {
  controller: webview.WebviewController | null = null;
  private sessions: Map<string, PreviewSession> = new Map<string, PreviewSession>();
  private streams: Map<string, PreviewStream> = new Map<string, PreviewStream>();
  private released: boolean = false;

  start(argsJson: string): void {
    const args: PreviewArgs | null = parseArgs(argsJson);
    if (args === null) {
      return;
    }
    this.openSession(args.id, `${args.tunnelId}`, args.preferredPort);
  }

  stop(argsJson: string): void {
    const args: PreviewArgs | null = parseArgs(argsJson);
    if (args === null) {
      return;
    }
    this.closeSession(`${args.tunnelId}`);
    this.reply(args.id, '');
  }

  // A reloaded page loses its tunnel IDs, so it releases everything still open.
  reset(argsJson: string): void {
    const args: PreviewArgs | null = parseArgs(argsJson);
    if (args === null) {
      return;
    }
    this.closeAllSessions();
    this.reply(args.id, '');
  }

  write(argsJson: string): void {
    const args: PreviewArgs | null = parseArgs(argsJson);
    if (args === null) {
      return;
    }
    this.send(args.id, `${args.streamId}`, `${args.data}`);
  }

  shutdownWrite(argsJson: string): void {
    const args: PreviewArgs | null = parseArgs(argsJson);
    if (args === null) {
      return;
    }
    this.halfClose(args.id, `${args.streamId}`);
  }

  credit(argsJson: string): void {
    const args: PreviewArgs | null = parseArgs(argsJson);
    if (args === null) {
      return;
    }
    const stream: PreviewStream | undefined = this.streams.get(`${args.streamId}`);
    const bytes: number = Math.floor(args.bytes);
    if (stream === undefined || !(bytes > 0) || bytes > WINDOW_BYTES) {
      return;
    }
    stream.credit = Math.min(WINDOW_BYTES, stream.credit + bytes);
    this.pump(stream);
  }

  closeSocket(argsJson: string): void {
    const args: PreviewArgs | null = parseArgs(argsJson);
    if (args === null) {
      return;
    }
    this.closeStream(`${args.streamId}`);
  }

  // The page or ability is going away: drop every listener and socket so no
  // loopback port stays bound, and stop calling back into a dead controller.
  release(): void {
    this.released = true;
    this.controller = null;
    this.closeAllSessions();
  }

  private async openSession(id: number, tunnelId: string, preferredPort: number): Promise<void> {
    if (!UUID.test(tunnelId)) {
      this.fail(id, 'Invalid preview tunnel ID');
      return;
    }
    const requested: number = Math.floor(preferredPort);
    if (!(requested >= 1) || requested > 65535) {
      this.fail(id, 'Invalid preview port');
      return;
    }
    const open: PreviewSession | undefined = this.sessions.get(tunnelId);
    if (open !== undefined) {
      this.reply(id, `,"origin":"${localOrigin(open.port)}"`);
      return;
    }
    if (this.sessions.size >= MAX_TUNNELS) {
      this.fail(id, 'Too many active previews');
      return;
    }
    let server: socket.TCPSocketServer | null = null;
    let port: number = 0;
    for (let attempt: number = 0; attempt < MAX_PORT_ATTEMPTS && server === null; attempt++) {
      const candidate: number = requested + attempt;
      if (candidate > 65535) {
        break;
      }
      const instance: socket.TCPSocketServer = socket.constructTCPSocketServerInstance();
      const address: socket.NetAddress = { address: LOOPBACK, port: candidate, family: 1 };
      try {
        await instance.listen(address);
      } catch (e) {
        closeServer(instance);
        continue;
      }
      // listen() does not fail on a taken port — it silently binds a random one
      // instead — so the real port always comes back from the socket itself.
      let bound: number = 0;
      try {
        const local: socket.NetAddress = await instance.getLocalAddress();
        bound = local.port !== undefined ? local.port : 0;
      } catch (e) {
        bound = 0;
      }
      if (!(bound >= 1) || bound > 65535) {
        closeServer(instance);
        continue;
      }
      server = instance;
      port = bound;
    }
    if (server === null) {
      this.fail(id, `No local preview port available starting at ${requested}`);
      return;
    }
    if (this.released) {
      closeServer(server);
      this.fail(id, 'Preview is unavailable');
      return;
    }
    const session: PreviewSession = new PreviewSession(tunnelId, port, server);
    this.sessions.set(tunnelId, session);
    server.on('connect', (client: socket.TCPSocketConnection) => this.accept(session, client));
    this.reply(id, `,"origin":"${localOrigin(port)}"`);
  }

  private accept(session: PreviewSession, client: socket.TCPSocketConnection): void {
    if (this.released || session.stopped || session.streams.size >= MAX_STREAMS) {
      closeConnection(client);
      return;
    }
    const streamId: string = util.generateRandomUUID(true);
    const stream: PreviewStream = new PreviewStream(session.tunnelId, streamId, client);
    this.streams.set(streamId, stream);
    session.streams.add(streamId);
    client.on('message', (value: socket.SocketMessageInfo) => this.receive(stream, value.message));
    client.on('close', () => this.peerClosed(stream));
    client.on('error', () => this.drop(stream));
    this.emit('open', stream, '');
  }

  private receive(stream: PreviewStream, message: ArrayBuffer): void {
    if (stream.closed) {
      return;
    }
    const bytes: Uint8Array = new Uint8Array(message);
    if (bytes.length === 0) {
      return;
    }
    // Nothing can pause an ArkTS socket read, so an unacknowledged browser that
    // keeps writing is dropped rather than buffered without a bound.
    if (stream.queuedBytes + bytes.length > MAX_PENDING_BYTES) {
      this.drop(stream);
      return;
    }
    for (let offset: number = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      stream.queue.push(bytes.slice(offset, Math.min(offset + CHUNK_BYTES, bytes.length)));
    }
    stream.queuedBytes += bytes.length;
    this.pump(stream);
  }

  private pump(stream: PreviewStream): void {
    while (!stream.closed && stream.credit > 0 && stream.queue.length > 0) {
      const chunk: Uint8Array | undefined = stream.queue.shift();
      if (chunk === undefined) {
        break;
      }
      stream.credit = stream.credit > chunk.length ? stream.credit - chunk.length : 0;
      stream.queuedBytes -= chunk.length;
      stream.seq += 1;
      this.emit('bytes', stream, `,"seq":${stream.seq},"data":"${base64.encodeToStringSync(chunk)}"`);
    }
    if (!stream.closed && stream.finPending && !stream.finSent && stream.queue.length === 0) {
      stream.finSent = true;
      this.emit('fin', stream, `,"seq":${stream.seq}`);
    }
  }

  private peerClosed(stream: PreviewStream): void {
    stream.finPending = true;
    this.pump(stream);
  }

  private drop(stream: PreviewStream): void {
    if (stream.closed) {
      return;
    }
    this.emit('close', stream, '');
    this.closeStream(stream.streamId);
  }

  private async send(id: number, streamId: string, data: string): Promise<void> {
    const stream: PreviewStream | undefined = this.streams.get(streamId);
    if (stream === undefined || stream.closed) {
      this.fail(id, 'Preview socket closed');
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = base64.decodeSync(data);
    } catch (e) {
      this.fail(id, 'Invalid preview bytes');
      return;
    }
    if (bytes.length === 0 || bytes.length > CHUNK_BYTES) {
      this.fail(id, 'Invalid preview bytes');
      return;
    }
    const options: socket.TCPSendOptions = { data: bytes.slice(0, bytes.length).buffer as ArrayBuffer };
    // One connection, one ordered write chain: the frontend awaits each write per
    // stream, but separate streams interleave and send() resolves asynchronously.
    const queued: Promise<void> = stream.writes.then(() => stream.connection.send(options));
    stream.writes = queued.then((): void => {}, (): void => {});
    try {
      await queued;
      this.reply(id, '');
    } catch (e) {
      this.fail(id, `${(e as BusinessError).message}`);
    }
  }

  // The remote end sent its FIN. ArkTS has no shutdown(Write), so the queued
  // writes are flushed and the whole connection closes: the browser still sees
  // the FIN that ends a response without Content-Length, but it cannot reuse
  // this connection for another keep-alive request and opens a new one instead.
  private async halfClose(id: number, streamId: string): Promise<void> {
    const stream: PreviewStream | undefined = this.streams.get(streamId);
    if (stream === undefined || stream.closed) {
      this.fail(id, 'Preview socket closed');
      return;
    }
    try {
      await stream.writes;
      await stream.connection.close();
      this.reply(id, '');
    } catch (e) {
      this.fail(id, `${(e as BusinessError).message}`);
    }
    stream.finPending = true;
    this.pump(stream);
  }

  private closeStream(streamId: string): void {
    const stream: PreviewStream | undefined = this.streams.get(streamId);
    if (stream === undefined) {
      return;
    }
    this.streams.delete(streamId);
    stream.closed = true;
    stream.queue = [];
    stream.queuedBytes = 0;
    const session: PreviewSession | undefined = this.sessions.get(stream.tunnelId);
    if (session !== undefined) {
      session.streams.delete(streamId);
    }
    detach(stream.connection);
    const connection: socket.TCPSocketConnection = stream.connection;
    stream.writes.then(() => closeConnection(connection), () => closeConnection(connection));
  }

  private closeSession(tunnelId: string): void {
    const session: PreviewSession | undefined = this.sessions.get(tunnelId);
    if (session === undefined) {
      return;
    }
    this.sessions.delete(tunnelId);
    session.stopped = true;
    const streamIds: string[] = [];
    session.streams.forEach((streamId: string) => streamIds.push(streamId));
    for (const streamId of streamIds) {
      this.closeStream(streamId);
    }
    try {
      session.server.off('connect');
    } catch (e) {
      // Never subscribed, or already detached.
    }
    closeServer(session.server);
  }

  private closeAllSessions(): void {
    const tunnelIds: string[] = [];
    this.sessions.forEach((_session: PreviewSession, tunnelId: string) => tunnelIds.push(tunnelId));
    for (const tunnelId of tunnelIds) {
      this.closeSession(tunnelId);
    }
  }

  private emit(event: string, stream: PreviewStream, extra: string): void {
    // tunnelId is a validated UUID, streamId is generated here and the payload is
    // base64 or a number, so this JSON needs no escaping.
    this.eval(`window.__onHarmonyPreview && window.__onHarmonyPreview({"event":"${event}",`
      + `"tunnelId":"${stream.tunnelId}","streamId":"${stream.streamId}"${extra}})`);
  }

  private reply(id: number, body: string): void {
    this.eval(`window.__onHarmonyPreview && window.__onHarmonyPreview({"event":"result","id":${id}${body}})`);
  }

  private fail(id: number, message: string): void {
    // JSON.stringify leaves U+2028/U+2029 raw, and those break the JS expression
    // runJavaScript evaluates — a syntax error there would drop the reply and
    // leave the frontend waiting forever.
    const text: string = JSON.stringify(message.replace(/[\u2028\u2029]/g, ' '));
    this.reply(id, `,"error":${text}`);
  }

  private eval(script: string): void {
    try {
      this.controller?.runJavaScript(script);
    } catch (e) {
      // The page navigated away; nothing is waiting for this result.
    }
  }
}
