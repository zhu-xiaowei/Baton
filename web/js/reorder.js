// Turn-scoped reorder buffer for headless stream frames.
//
// The transport (bridge → Lambda → API GW → app) can deliver frames out of
// order because each WS frame is an independent, variable-duration Lambda
// invocation. The bridge stamps every frame of a turn with a monotonic `seq`;
// this buffer reassembles them into the send order before they touch the UI.
//
// Model (a splice-able queue whose head drains when contiguous):
//   ordered region  → already applied to `blocks`, seq [0, nextSeq)
//   pending region  → arrived early, keyed by seq, waiting to become contiguous
// Consumer reads `blocks` (committed text per block); it never sees `pending`.

// A single assistant turn's block state, mutated only in seq order.
// `committed` is in-order text/thinking; `inputJson` is in-order tool_use partial JSON.
function newBlock(blockId, kind) {
  return { blockId: blockId, kind: kind || 'text', name: null, committed: '', inputJson: '', stopped: false };
}

export class ReorderBuffer {
  constructor() {
    this.nextSeq = 0;          // next seq expected in the ordered region
    this.pending = new Map();  // seq → frame, arrived ahead of nextSeq
    this.blocks = new Map();   // blockId → block, mutated only in seq order
    this.finalSeq = null;      // total frame count for the turn (from stream_end)
    this.ended = false;        // true once every frame up to finalSeq is applied
    this.supersededThrough = -1; // blockIds <= this are owned by an authoritative row; stragglers ignored
  }

  // Ingest one frame. seq < nextSeq is a duplicate/late arrival → dropped (idempotent).
  push(frame) {
    if (!frame || typeof frame.seq !== 'number') return;
    if (frame.seq < this.nextSeq) return;
    if (frame.seq > this.nextSeq) { this.pending.set(frame.seq, frame); return; }
    this._drainFrom(frame);
    this._checkEnd();
  }

  // Apply `head` (which is at nextSeq) then every now-contiguous pending frame.
  _drainFrom(head) {
    this._apply(head);
    this.nextSeq++;
    while (this.pending.has(this.nextSeq)) {
      this._apply(this.pending.get(this.nextSeq));
      this.pending.delete(this.nextSeq);
      this.nextSeq++;
    }
  }

  // stream_end carries finalSeq (= total frames). The turn is done only once the
  // ordered region has reached it — a gap keeps us waiting for the missing frame.
  end(finalSeq) {
    if (typeof finalSeq === 'number') this.finalSeq = finalSeq;
    this._checkEnd();
  }

  _checkEnd() {
    if (this.finalSeq != null && this.nextSeq >= this.finalSeq) this.ended = true;
  }

  // start is a block's only creator; delta/input/stop can arrive first (reordered)
  // and must lazily create it, or a dropped-then-resent start would lose the block.
  _block(frame) {
    var b = this.blocks.get(frame.blockId);
    if (!b) { b = newBlock(frame.blockId, frame.kind); this.blocks.set(frame.blockId, b); }
    return b;
  }

  _apply(frame) {
    // Straggler for a block an authoritative row already delivered → seq advances but no render.
    if (frame.blockId <= this.supersededThrough) return;
    var b = this._block(frame);
    switch (frame.t) {
      case 'start': if (frame.kind) b.kind = frame.kind; if (frame.name) b.name = frame.name; break;
      case 'delta': b.committed += frame.chunk || ''; break;
      case 'input': b.kind = 'tool_use'; b.inputJson += frame.chunk || ''; break;
      case 'stop': b.stopped = true; break;
    }
  }

  // An authoritative row superseded every block seen so far. Keep seq bookkeeping
  // (so a NEW block continuing this streamId isn't stranded), drop rendered blocks,
  // and mark existing blockIds superseded so their late stragglers don't re-render.
  softReset() {
    var maxBid = this.supersededThrough;
    for (var bid of this.blocks.keys()) if (bid > maxBid) maxBid = bid;
    this.supersededThrough = maxBid;
    this.blocks = new Map();
  }

  // Ordered blocks, ascending by blockId — the render order for the turn.
  orderedBlocks() {
    return Array.from(this.blocks.values()).sort(function (a, b) { return a.blockId - b.blockId; });
  }

  // True while a gap is holding back frames that have already arrived — the UI
  // should keep showing "still streaming" rather than declaring the block done.
  hasGap() {
    return this.pending.size > 0;
  }
}
