export class ActiveTurnRegistry {
  constructor() {
    this.sessions = new Map();
  }

  register(sessionId, turnId, liveTurn) {
    if (!sessionId || !turnId || !liveTurn) return false;
    var turns = this.sessions.get(sessionId);
    if (!turns) {
      turns = new Map();
      this.sessions.set(sessionId, turns);
    }
    turns.set(turnId, liveTurn);
    return true;
  }

  discard(sessionId, turnId) {
    var turns = this.sessions.get(sessionId);
    if (!turns) return false;
    var removed = turns.delete(turnId);
    if (!turns.size) this.sessions.delete(sessionId);
    return removed;
  }

  get(sessionId, turnId) {
    return this.sessions.get(sessionId)?.get(turnId) || null;
  }
}
