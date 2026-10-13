export class ClientTurnOrder {
  constructor(options = {}) {
    this.waiters = new Map();
    this.inFlight = new Set();
    this.submitted = new Set();
    this.maxSubmitted = Math.max(100, options.maxSubmitted || 5000);
    this.waitTimeoutMs = Math.max(1, options.waitTimeoutMs || 10000);
  }

  deferred(turnId) {
    var current = this.waiters.get(turnId);
    if (current) return current;
    var resolve;
    var receive;
    var promise = new Promise((done) => { resolve = done; });
    var received = new Promise((done) => { receive = done; });
    current = { promise, resolve, received, receive, waiting: 0 };
    this.waiters.set(turnId, current);
    return current;
  }

  async waitFor(turnId) {
    if (!turnId || this.submitted.has(turnId)) return;
    var current = this.deferred(turnId);
    current.waiting++;
    var timer;
    try {
      // Only a predecessor that has not arrived can be missing. Attachment
      // resolution or runtime startup may take much longer than this timeout.
      if (!this.inFlight.has(turnId)) {
        await Promise.race([
          current.received,
          new Promise((resolve, reject) => {
            timer = setTimeout(() => {
              var error = new Error(`Previous turn ${turnId} did not reach the Bridge`);
              error.code = 'previous_turn_missing';
              error.previousTurnId = turnId;
              reject(error);
            }, this.waitTimeoutMs);
          }),
        ]);
        clearTimeout(timer);
      }
      var error = await current.promise;
      if (error) throw error;
    } finally {
      clearTimeout(timer);
      current.waiting--;
      if (current.waiting === 0
        && !this.submitted.has(turnId)
        && this.waiters.get(turnId) === current) {
        this.waiters.delete(turnId);
      }
    }
  }

  markSubmitted(turnId) {
    if (!turnId || this.submitted.has(turnId)) return false;
    this.submitted.add(turnId);
    var waiter = this.waiters.get(turnId);
    if (waiter) {
      this.waiters.delete(turnId);
      waiter.receive();
      waiter.resolve();
    }
    while (this.submitted.size > this.maxSubmitted) {
      this.submitted.delete(this.submitted.values().next().value);
    }
    return true;
  }

  async run(message, task) {
    var turnId = message?.turnId || '';
    var previousTurnId = message?.previousTurnId || '';
    this.inFlight.add(turnId);
    this.waiters.get(turnId)?.receive();
    var ordered = false;
    try {
      if (previousTurnId && previousTurnId !== turnId) {
        await this.waitFor(previousTurnId);
      }
      ordered = true;
      // task resolves once the runtime accepts/enqueues the message.
      // Runtime turn completion is intentionally not part of transport ordering.
      return await task();
    } catch (error) {
      if (!ordered) {
        // Fail the dependent chain too, without marking an unsent turn as
        // submitted. Every turn remains eligible for a later retry.
        this.waiters.get(turnId)?.resolve(error);
        this.waiters.delete(turnId);
      }
      throw error;
    } finally {
      this.inFlight.delete(turnId);
      if (ordered) this.markSubmitted(turnId);
    }
  }
}
