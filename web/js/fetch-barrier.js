export class FetchBarrier {
  constructor(options = {}) {
    this.sessionId = options.sessionId || '';
    this.generation = options.generation || 0;
    this.pendingIds = new Set(options.pendingIds || []);
    this.events = [];
    this.state = 'open';
    this.promise = null;
  }

  capture(event) {
    if (this.state !== 'open') return false;
    this.events.push(event);
    return true;
  }

  beginCommit() {
    if (this.state !== 'open') return false;
    this.state = 'committing';
    return true;
  }

  close() {
    if (this.state === 'closed' || this.state === 'invalid') return false;
    this.state = 'closed';
    return true;
  }

  invalidate() {
    if (this.state === 'closed' || this.state === 'invalid') return false;
    this.state = 'invalid';
    return true;
  }

  isOpen() {
    return this.state === 'open' || this.state === 'committing';
  }
}

export class FetchBarrierCoordinator {
  constructor() {
    this.generation = 0;
    this.active = null;
  }

  open(options = {}) {
    if (this.active?.isOpen()) this.active.invalidate();
    var barrier = new FetchBarrier({
      ...options,
      generation: ++this.generation,
    });
    this.active = barrier;
    return barrier;
  }

  current(sessionId) {
    var barrier = this.active;
    if (!barrier?.isOpen()) return null;
    if (sessionId && barrier.sessionId !== sessionId) return null;
    return barrier;
  }

  isCurrent(barrier) {
    return !!barrier
      && this.active === barrier
      && barrier.generation === this.generation
      && barrier.isOpen();
  }

  close(barrier) {
    if (!this.isCurrent(barrier)) return false;
    barrier.close();
    this.active = null;
    return true;
  }

  invalidate() {
    if (this.active) this.active.invalidate();
    this.active = null;
    this.generation++;
  }
}
