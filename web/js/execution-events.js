export class ExecutionEventQueue {
  constructor() {
    this.executions = new Map();
  }

  push(event) {
    let execution = this.executions.get(event.executionId);
    if (!execution) {
      execution = { next: 0, pending: new Map(), ended: false };
      this.executions.set(event.executionId, execution);
    }
    if (execution.ended || event.executionSeq < execution.next) return [];
    if (!execution.pending.has(event.executionSeq)) execution.pending.set(event.executionSeq, event);
    return this.drain(execution);
  }

  drain(execution) {
    const ready = [];
    while (execution.pending.has(execution.next)) {
      const event = execution.pending.get(execution.next);
      execution.pending.delete(execution.next++);
      ready.push({ ...event, _executionOrdered: true });
      if (event.action === 'stream_end' && event.continued === false) execution.ended = true;
    }
    return ready;
  }

  hasGap(id) {
    const execution = this.executions.get(id);
    return !!execution?.pending.size;
  }

  recover(id) {
    const execution = this.executions.get(id);
    if (!execution || execution.ended) return [];
    const ready = [];
    while (execution.pending.size) {
      execution.next = Math.min(...execution.pending.keys());
      ready.push(...this.drain(execution));
    }
    return ready;
  }

  reset() {
    this.executions.clear();
  }
}
