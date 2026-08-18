export const STREAM_DELTA_BATCH_MS = 50;
export const STREAM_CHUNK_LIMIT_BYTES = 24 * 1024;

export class StreamFramer {
  constructor(onFrame, options = {}) {
    this.onFrame = onFrame;
    this.batchMs = options.batchMs ?? STREAM_DELTA_BATCH_MS;
    this.maxChunkBytes = Number.isFinite(options.maxChunkBytes)
      ? Math.max(4, options.maxChunkBytes)
      : STREAM_CHUNK_LIMIT_BYTES;
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.reset();
  }

  reset() {
    this.cancel();
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
    if (typeof frame.chunk !== 'string'
      || Buffer.byteLength(frame.chunk) <= this.maxChunkBytes) {
      this.onFrame?.(frame);
      return;
    }
    for (const chunk of splitUtf8(frame.chunk, this.maxChunkBytes)) {
      this.onFrame?.({ ...frame, chunk });
    }
  }
}

function splitUtf8(text, maxBytes) {
  const chunks = [];
  let chunk = '';
  let bytes = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char);
    if (chunk && bytes + charBytes > maxBytes) {
      chunks.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += char;
    bytes += charBytes;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
