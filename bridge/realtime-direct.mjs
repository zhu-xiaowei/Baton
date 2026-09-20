import { randomUUID } from 'node:crypto';
import { authenticateFrame, createHeaderSigner } from './terminal-direct-protocol.mjs';
import { isRealtimeEvent, realtimePayload } from './realtime-direct-protocol.mjs';

export class RealtimeSender {
  constructor({ send, fallback, resolveTimeout = 2000 }) {
    this.send = send;
    this.fallback = fallback;
    this.resolveTimeout = resolveTimeout;
    this.routes = new Map();
    this.requests = new Map();
    this.queues = new Map();
    this.pendingBytes = 0;
    this.active = true;
  }

  start() {
    if (!this.active) return;
    this.send(JSON.stringify({ action: 'realtime_direct', v: 1, op: 'hello' }));
  }

  handle(message) {
    if (message?.action !== 'realtime_direct' || message.v !== 1) return false;
    if (!this.active) return true;
    if (message.type === 'credentials') {
      if (!message.credentials || message.credentials.expiresAt * 1000 <= Date.now() + 5000) return true;
      this.authorization = message;
      clearTimeout(this.renew);
      this.renew = setTimeout(() => this.start(), Math.max(1000, message.credentials.expiresAt * 1000 - Date.now() - 60000));
    } else if (message.type === 'invalidate') {
      for (const [key, route] of this.routes) {
        if (route.sessionId === message.sessionId) this.routes.delete(key);
      }
    } else if (message.type === 'targets' || message.type === 'error') {
      const request = this.requests.get(message.requestId);
      if (request) {
        this.requests.delete(message.requestId);
        clearTimeout(request.timer);
        request.finish(message.type === 'targets' && !message.useLambda ? message.targets : null);
      }
    } else if (message.type === 'unsupported') {
      this.authorization = null;
    }
    return true;
  }

  targets(event) {
    const key = JSON.stringify([event.sessionId, event.replyConnectionId || '']);
    const cached = this.routes.get(key);
    if (cached && cached.expires > Date.now()) return cached.promise;
    const requestId = randomUUID();
    const route = { sessionId: event.sessionId, expires: Date.now() + 30000 };
    route.promise = new Promise(resolve => {
      const finish = targets => {
        if (!targets) route.expires = Date.now() + 1000;
        resolve(targets);
      };
      const timer = setTimeout(() => {
        this.requests.delete(requestId);
        finish(null);
      }, this.resolveTimeout);
      this.requests.set(requestId, { finish, timer });
      if (!this.send(JSON.stringify({ action: 'realtime_direct', v: 1, op: 'resolve', requestId,
        sessionId: event.sessionId, replyConnectionId: event.replyConnectionId || '' }))) {
        clearTimeout(timer);
        this.requests.delete(requestId);
        finish(null);
      }
    });
    this.routes.set(key, route);
    if (this.routes.size > 128) this.routes.delete(this.routes.keys().next().value);
    return route.promise;
  }

  enqueue(event) {
    if (!this.active || !this.authorization || !isRealtimeEvent(event)
      || (event.action === 'messages' && event.noCache !== true)) return false;
    const encoded = JSON.stringify(event);
    const bytes = Buffer.byteLength(encoded);
    if (this.pendingBytes + bytes > 1024 * 1024) return false;
    const snapshot = JSON.parse(encoded);
    this.pendingBytes += bytes;
    const key = JSON.stringify([event.sessionId, event.turnId]);
    const queue = (this.queues.get(key) || Promise.resolve()).then(() => this.deliver(snapshot))
      .catch(() => { if (this.active) this.fallback(snapshot); })
      .finally(() => {
        this.pendingBytes -= bytes;
        if (this.queues.get(key) === queue) this.queues.delete(key);
      });
    this.queues.set(key, queue);
    return true;
  }

  async deliver(event) {
    if (!this.active) return;
    const targets = await this.targets(event);
    if (!this.active) return;
    if (!Array.isArray(targets)) return this.fallback(event);
    const direct = targets.filter(target => target.dataId && target.frameKey && target.bindingId);
    const fallback = { ...event, directDeliveredTo: direct.map(target => target.controlId) };
    if (Buffer.byteLength(JSON.stringify(fallback)) > 31000) return this.fallback(event);
    const frames = await Promise.all(direct.map(async target => {
      const body = JSON.stringify(await authenticateFrame(JSON.stringify({ action: 'realtime_direct_frame', v: 1,
        bindingId: target.bindingId, event: realtimePayload(event) }), target.frameKey));
      const authorization = this.authorization;
      if (target.authorization !== authorization) {
        target.authorization = authorization;
        target.sign = createHeaderSigner({ endpoint: authorization.endpoint, region: authorization.region,
          credentials: authorization.credentials, target: target.dataId, action: 'realtime_direct_data' });
      }
      return target.sign(body);
    }));
    if (!this.active) return;
    const delivered = [];
    for (let index = 0; index < frames.length; index++) {
      if (this.send(frames[index])) delivered.push(direct[index].controlId);
    }
    if (delivered.length !== targets.length) this.fallback({ ...event, directDeliveredTo: delivered });
  }

  dispose() {
    this.active = false;
    this.authorization = null;
    clearTimeout(this.renew);
    for (const request of this.requests.values()) {
      clearTimeout(request.timer);
      request.finish(null);
    }
    this.requests.clear();
    this.routes.clear();
  }
}
