export class PermissionQueue {
  constructor() {
    this.sessions = new Map();
  }

  current(sessionId) {
    return this.sessions.get(sessionId)?.current || null;
  }

  has(sessionId) {
    return !!this.current(sessionId);
  }

  enqueue(sessionId, request) {
    const state = this.sessions.get(sessionId);
    if (!state) {
      this.sessions.set(sessionId, { current: request, stack: [] });
      return { current: request, shouldPresent: true };
    }
    if (state.current.requestId === request.requestId) {
      state.current = request;
      return { current: request, shouldPresent: true };
    }
    const duplicate = state.stack.findIndex((item) => item.requestId === request.requestId);
    if (duplicate !== -1) {
      state.stack[duplicate] = request;
      return { current: state.current, shouldPresent: false };
    }
    state.stack.push(request);
    return { current: state.current, shouldPresent: false };
  }

  resolve(sessionId, requestId) {
    const state = this.sessions.get(sessionId);
    if (!state || state.current.requestId !== requestId) return null;
    const resolved = state.current;
    const next = state.stack.pop() || null;
    if (next) state.current = next;
    else this.sessions.delete(sessionId);
    return { resolved, next };
  }

  dismiss(sessionId, requestId) {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    if (state.current.requestId === requestId) {
      return this.resolve(sessionId, requestId);
    }
    const index = state.stack.findIndex((item) => item.requestId === requestId);
    if (index === -1) return null;
    const [resolved] = state.stack.splice(index, 1);
    return { resolved, next: null, current: state.current };
  }

  clear(sessionId) {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    this.sessions.delete(sessionId);
    return state;
  }
}
