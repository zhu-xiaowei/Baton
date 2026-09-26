import { isPromptUserMessage, LiveTurnStream } from './live-turn-stream.mjs';

function promptId(message) {
  const clientId = String(message.nativeId || '').match(/^(?:codex|live):user:(.+)$/)?.[1];
  return clientId || (message.nativeId ? message.uuid : `sent-${message.uuid}`);
}

function messageKey(message) {
  return message.nativeId || message.uuid;
}

export class LiveExecutionStream {
  constructor(options) {
    this.options = options;
    this.executionId = options.turnId;
    this.nextSeq = 0;
    this.inputs = new Map();
    this.segments = new Map();
    this.messages = new Map();
    this.tools = new Map();
    this.current = null;
    this.ended = false;
  }

  registerInput(id, ack) {
    if (!this.inputs.has(id)) this.inputs.set(id, { consumed: false, ack });
  }

  consumeInputs(ids) {
    for (const id of ids || []) {
      const input = this.inputs.get(id);
      if (input) input.consumed = true;
    }
  }

  rejectInput(id, detail) {
    const input = this.inputs.get(id);
    if (input) {
      input.consumed = true;
      input.ack?.(false, detail);
    }
    if (!this.current && this.pendingCount === 0) this.sendEnd({ error: 'unavailable' });
  }

  get pendingCount() {
    return [...this.inputs.values()].filter((input) => !input.consumed).length;
  }

  publish(event) {
    return this.options.send({
      ...event,
      executionId: this.executionId,
      executionSeq: this.nextSeq++,
      consumedInputIds: [...this.inputs].filter(([, input]) => input.consumed).map(([key]) => key),
    });
  }

  segment(id = this.executionId) {
    if (!this.segments.has(id)) {
      const segment = new LiveTurnStream({
        ...this.options,
        turnId: id,
        send: (event) => this.publish(event),
      });
      this.segments.set(id, segment);
      this.options.onSegment?.(id, segment);
    }
    return this.segments.get(id);
  }

  start() {
    if (!this.current) this.current = this.segment();
    return this.current.start();
  }

  sendAuthoritative(message, options = {}) {
    const previous = this.messages.get(messageKey(message));
    let target = previous;
    if (!target && isPromptUserMessage(message)
      && !/^\[Request interrupted by user/.test(typeof message.content === 'string'
        ? message.content : message.content?.[0]?.text || '')) {
      const id = promptId(message);
      this.consumeInputs([id, message.uuid, `sent-${message.uuid}`]);
      if (this.current && this.current.turnId !== id) {
        this.current.sendEnd({ continued: true });
      }
      this.current = this.segment(id);
      target = this.current;
    }
    if (!target && Array.isArray(message.content)) {
      const result = message.content.find((block) => block.type === 'tool_result');
      target = result && this.tools.get(result.tool_use_id);
    }
    if (!target) {
      this.start();
      target = this.current;
    }
    this.messages.set(messageKey(message), target);
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'tool_use') this.tools.set(block.id, target);
    }
    const canonical = { ...message, turnId: target.turnId };
    if (target.isEnded()) {
      this.publish({ action: 'messages', sessionId: this.options.sessionId, messages: [canonical], noCache: true });
      return true;
    }
    return target.sendAuthoritative(canonical, options);
  }

  sendEnd(options = {}) {
    if (this.ended) return false;
    this.consumeInputs(options.consumedInputIds);
    if (options.continued || (!options.error && this.pendingCount)) return false;
    if (options.error) {
      for (const input of this.inputs.values()) {
        if (!input.consumed) input.ack?.(false, options.error);
        input.consumed = true;
      }
    }
    this.start();
    this.current.sendEnd({ ...options, continued: false });
    this.ended = true;
    return true;
  }

  sendBlockStart(frame) { this.start(); return this.current.sendBlockStart(frame); }
  sendDelta(frame) { this.start(); return this.current.sendDelta(frame); }
  sendToolInput(frame) { this.start(); return this.current.sendToolInput(frame); }
  sendBlockStop(frame) { return this.current?.sendBlockStop(frame); }
  sendInterrupt(timestamp) { this.start(); return this.current.sendInterrupt(timestamp); }
  emit(action, payload) { this.start(); return this.current.emit(action, payload); }
  createMessagesEvent(messages, options) { this.start(); return this.current.createMessagesEvent(messages, options); }
  isEnded() { return this.ended; }
}
