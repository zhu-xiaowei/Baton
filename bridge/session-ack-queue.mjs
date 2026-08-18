import { randomUUID } from 'crypto';

export class SessionAckQueue {
  constructor(options = {}) {
    this.send = options.send;
    this.defaultTimeout = options.defaultTimeout || 5000;
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.createDeliveryId = options.createDeliveryId || randomUUID;
    this.sessions = new Map();
  }

  enqueue(data, timeout = this.defaultTimeout) {
    var sessionId = data?.sessionId || '';
    if (!sessionId) return Promise.resolve(false);
    return new Promise((resolve) => {
      var session = this.sessions.get(sessionId);
      if (!session) {
        session = { active: null, pending: [] };
        this.sessions.set(sessionId, session);
      }
      var deliveryId = this.createDeliveryId();
      session.pending.push({
        data: { ...data, deliveryId },
        deliveryId,
        timeout,
        resolve,
      });
      this.startNext(sessionId, session);
    });
  }

  acknowledge(sessionId, deliveryId) {
    var session = this.sessions.get(sessionId);
    if (!session?.active || session.active.deliveryId !== deliveryId) {
      return false;
    }
    this.finishActive(sessionId, session, true);
    return true;
  }

  startNext(sessionId, session) {
    if (session.active || !session.pending.length) return;
    var active = session.pending.shift();
    session.active = active;
    if (!this.send(active.data)) {
      this.finishActive(sessionId, session, false);
      return;
    }
    active.timer = this.setTimer(() => {
      if (session.active === active) {
        this.finishActive(sessionId, session, false);
      }
    }, active.timeout);
  }

  finishActive(sessionId, session, acknowledged) {
    var active = session.active;
    if (!active) return;
    if (active.timer != null) this.clearTimer(active.timer);
    session.active = null;
    active.resolve(acknowledged);
    if (!session.pending.length) {
      this.sessions.delete(sessionId);
      return;
    }
    this.startNext(sessionId, session);
  }

  clear() {
    for (var session of this.sessions.values()) {
      if (session.active) {
        if (session.active.timer != null) this.clearTimer(session.active.timer);
        session.active.resolve(false);
      }
      for (var pending of session.pending) pending.resolve(false);
    }
    this.sessions.clear();
  }
}
