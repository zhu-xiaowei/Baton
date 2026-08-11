export const STREAM_DELTA_BATCH_MS = 50;

export class StreamFramer {
  constructor(onFrame, options = {}) {
    this.onFrame = onFrame;
    this.batchMs = options.batchMs ?? STREAM_DELTA_BATCH_MS;
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.reset();
  }

  reset() {
    this.cancel();
    this.seq = 0;
  }

  start(blockId, kind, name = null) {
    this.flush();
    this.emit({ t: 'start', blockId, kind, name });
  }

  delta(blockId, chunk) {
    this.accumulate('delta', blockId, chunk);
  }

  input(blockId, chunk) {
    this.accumulate('input', blockId, chunk);
  }

  stop(blockId) {
    this.flush();
    this.emit({ t: 'stop', blockId });
  }

  finish() {
    this.flush();
    return this.seq;
  }

  cancel() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.batch = null;
  }

  accumulate(type, blockId, chunk) {
    if (this.batch && (this.batch.t !== type || this.batch.blockId !== blockId)) {
      this.flush();
    }
    if (!this.batch && !this.timer) {
      this.batch = { t: type, blockId, chunk };
      this.flush();
      this.timer = this.setTimer(() => {
        this.timer = null;
        this.flush();
      }, this.batchMs);
      return;
    }
    if (!this.batch) this.batch = { t: type, blockId, chunk: '' };
    this.batch.chunk += chunk;
    if (!this.timer) {
      this.timer = this.setTimer(() => {
        this.timer = null;
        this.flush();
      }, this.batchMs);
    }
  }

  flush() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    const batch = this.batch;
    if (!batch) return;
    this.batch = null;
    this.emit(batch);
  }

  emit(frame) {
    this.onFrame?.({ ...frame, seq: this.seq++ });
  }
}
