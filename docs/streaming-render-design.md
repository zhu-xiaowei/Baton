# Streaming Ordering and Rendering Design

> Status: strict streaming implemented; history merge refactor pending
> Date: 2026-08-27
> Scope: Claude Code, Codex, Bridge, WebSocket Server, and the Web frontend

For the target merge strategy across REST, the request-time historyBuffer, local history, and DOM, plus current open issues, see
[`message-history-merge.md`](message-history-merge.md).

## 1. Core Principles

One user question/answer exchange is uniquely identified by `turnId`. Web generates the `turnId` before sending the question and immediately writes it onto the user bubble:

```text
data-anchor="<turnId>"
```

Bridge assigns a contiguous `seq` starting from the turn's first shared render event:

```text
stream_turn_start  seq=0
messages           seq=1
stream_block_start seq=2
stream_delta       seq=3
stream_block_stop  seq=4
messages           seq=5
stream_end         seq=6
```

A turn has exactly one sequence. Event type plays no part in ordering decisions.

The only ordering rule Web applies to received events is:

```text
turnId + seq
```

When `seq=N` is missing, every event with `seq>N` stays buffered and must not produce DOM side effects.

## 2. Minimal Protocol Fields

Every active-turn shared event must include:

| Field | Responsibility |
|---|---|
| `action` | Determines the behavior executed after the event is consumed |
| `sessionId` | Determines which Session the event belongs to |
| `turnId` | Links the user question, answer, permissions, and tool nodes |
| `seq` | The unique transport and consumption order within the turn |

Each action then carries its own payload, such as `chunk`, `kind`, `name`, `messages`, or `error`.

The protocol no longer includes:

- `clientId`
- `streamId`
- `bridgeEpoch`
- `turnSeq`
- `messageSeq`
- `finalSeq`
- `subscriptionEpoch`
- `blockIds`
- `send_message_binding`

The `seq` of `stream_block_start` also serves as that node's internal `blockId`. Subsequent delta, input, and stop events apply to the current block by virtue of the ordered event stream; no separate `blockId` is sent.

## 3. Event Boundaries

The following shared render events must enter the turn sequence:

- `stream_turn_start`
- `stream_block_start`
- `stream_delta`
- `stream_tool_input`
- `stream_block_stop`
- in-turn `messages`
- in-turn `permission_request`
- in-turn `permission_resolved`
- `stream_end`

`stream_end` is the terminal event. Once it is sent, the turn can produce no more events with a seq.

The following single-connection or control events do not enter the turn sequence:

- `subscribe`
- `reveal_permission`
- `send_message`
- `send_message_result`
- `messages_ack`
- heartbeat
- session/project status sync

The reason is that these events may be sent to only one connection. If they consumed a shared seq, other windows would wait forever for a number they will never receive.

## 4. Bridge

### 4.1 Single Send Outlet

`LiveTurnStream` is the single shared-event outlet for an active turn:

```text
runtime callback
→ LiveTurnStream.emit(action, payload)
→ assign seq
→ validate sessionId + turnId + seq
→ send WS
```

The underlying Claude/Codex framers are responsible only for:

- block boundaries
- delta batching
- UTF-8-safe chunking

They do not assign transport sequence numbers.

### 4.2 Send Validation

Bridge `wsSend()` performs runtime validation on every active-turn action:

- `sessionId` must be non-empty
- `turnId` must be non-empty
- `seq` must be a non-negative integer

If any field is missing it throws immediately; half-strict events are never sent.

### 4.3 Bridge Restart

`seq` exists only in Bridge memory and every turn starts from 0, so no `bridgeEpoch` is needed.

After a Bridge restart:

- the old active turn no longer continues streaming
- new turns use a new `turnId`
- a new turn's `seq` starts from 0
- persisted history messages are unaffected

## 5. Server

Server repeats the same validation on active-turn events from Bridge. Invalid events return `400` and are not forwarded to Web.

Server's only responsibilities are:

1. Broadcast shared events to all subscribed windows of that Session.
2. Write ordinary watcher `messages` to DDB and return `messages_ack`.
3. Only broadcast runtime-owned `messages{noCache:true}`; the corresponding JSONL watcher owns final persistence.

DDB does not store streaming transport fields:

- does not store `turnId`
- does not store `seq`
- does not restore active streaming state

History records store only final message fields such as `uuid/nativeId/type/content/timestamp`.

## 6. Web

Frontend streaming code lives in `web/js/streaming.js`, split into three layers.

### 6.1 TurnEventQueue

Handles only transport reordering:

```text
pending[seq] = event

while pending[nextSeq]:
    dispatch(pending[nextSeq])
    nextSeq += 1
```

Invariants:

- zero side effects until the gap closes
- identical duplicate events are idempotent
- different content for the same seq is a protocol error
- stop, authority, permission, and end can never skip past a missing delta
- different turns use independent queues

### 6.2 StreamCoordinator

Handles only turn/block state:

- the block-start seq is the node ID
- the next block can be shown only after a block finishes input and its UI reveal completes
- the next buffered turn can start showing only after a turn completes
- authority only confirms or locally corrects existing nodes

It does not handle WS arrival order.

### 6.3 StreamingDomRenderer

Executes only declarative DOM operations:

- create the turn container
- create text, thinking, or tool nodes
- append already-ordered text
- update tool input/result
- locally reconcile authority messages
- preserve expanded state and DOM identity

It does not read WS events and does not decide ordering.

## 7. User Message Association

When Web sends:

```json
{
  "action": "send_message",
  "sessionId": "...",
  "turnId": "sent-uuid",
  "text": "..."
}
```

At the same moment it creates:

```html
<div class="user-message" data-anchor="sent-uuid">...</div>
```

Bridge and Server use that `turnId` unchanged. The streaming renderer locates it only via an exact selector:

```text
[data-anchor="<turnId>"]
```

Therefore none of the following are needed:

- a clientId-to-streamId binding event
- text content matching
- "most recent question" inference
- timestamp ownership

When multiple questions with identical text are sent quickly, each question still has a distinct `turnId`, so replies never land in the wrong place.

## 8. Multiple Windows and Late Join

Subscription is fire-and-forget. Server only records the subscription; it sends no ack. Bridge neither stores nor replays the active turn.

A new window joining a running turn uses these minimal rules:

1. `seq=0` received: strict streaming proceeds normally from turn start.
2. The first valid event is `seq=1 messages(user)`: Web locally fills in a payload-less
   `stream_turn_start(seq=0)`, then continues streaming from `seq=1`.
3. The current node's `stream_block_start` is missing: discard that node's partial delta/stop.
4. A complete `messages` is received: immediately render the completed node whose start was missing using authority.
5. A later `stream_block_start` is received: resume strict streaming from that complete node boundary.
6. `stream_end` arrives: use the whole-turn deduplicated authority to fill in still-missing nodes and end the turn.
7. Subsequent new turns automatically resume normal streaming upon receiving `seq=0/1`.

`stream_end` carries the complete deduplicated authority produced by the turn. It only fills in missing UUID/nativeId,
and never duplicates nodes already confirmed by real-time events. The recovery logic uses no time windows.

### 8.1 Connection Recovery

> This section describes the strict turn recovery invariants. The unified FetchBarrier for REST/historyBuffer/local history
> is still pending a refactor per [`message-history-merge.md`](message-history-merge.md).

Returning from background to foreground and unexpected WS disconnects use the same recovery chain:

1. Immediately discard the old connection's turn seq buffers, but do not modify existing DOM.
2. After the new WS subscribes, request REST history; the same response reads Session status in parallel with strong consistency.
3. Until REST completes, strict turn events on the new connection are only buffered, not rendered.
4. REST history is merged by UUID/nativeId first, then buffered WS events are released through the unified queue.
5. `completed` closes out turns from before the reconnect; `running` keeps the outstanding turn; `needs_input`
   keeps the turn but stops the spinner.
6. Resume streaming from the next complete block/permission checkpoint.
7. A partial block from before the reconnect is replaced in place once its complete authority arrives; blocks created after the reconnect still reveal progressively as normal.

Leaving the detail page still fully disconnects and clears Session state; only connection recovery within the same detail page uses the incremental flow above.
The recovery chain no longer sends `reveal_turn_state`, and there is no online silence-timeout probe. A normal connection trusts only strictly ordered
WS lifecycle events; foreground/reconnect boundaries reuse the status calibration from the messages request that must run anyway.

`stream_block_stop` only signals that the block will receive no more deltas; it carries no complete content. A full overwrite can only be triggered by
the corresponding authority `messages` or `stream_end.messages`.

## 9. Authority Messages

In-turn authority `messages` also carry a seq and cannot bypass a gap.

Handling rules:

1. Streamed content matches authority: only mark it committed, do not replace DOM.
2. Content differs: locally patch the corresponding node.
3. tool result: update OUT by the tool's own native ID.
4. Never rebuild the whole `.messages`.
5. Runtime-owned JSONL messages are only persisted, not broadcast; seq-less watcher messages from external TUI/IDE are handled as
   ordinary history messages and do not reopen an ended turn.
6. Codex runtime ownership lasts from this turn's `task_started` until the next turn's `task_started`. An intermediate
   `turn_aborted/task_complete` is not a release boundary, ensuring trailing tool results after it are still only persisted.
7. On interruption, the runtime sends a single authority before `stream_end`; Web does not synthesize nodes from error codes or display text.

## 10. First Entry into a Session

Web first sends `subscribe` while fetching REST history. The two kinds of WS messages are handled separately:

The `reveal_permission` immediately following `subscribe` only restores the current permission state. It does not request or replay a streaming
snapshot. CC uses the hook/runtime pending request already stored by Bridge; Codex TUI uses a
permission-only app-server observation to discover unanswered approvals. Requests that still belong to an unfinished live turn
are assigned a new unified seq; hook/TUI requests without a live turn are standalone control events without a seq.

Permissions are control-plane UI: if a sequenced permission is blocked by a missing earlier render event, Web performs a single short-delay,
idempotent fallback dispatch that only shows/closes the dialog and does not advance the `TurnEventQueue`. When the strict queue later consumes
the same `turnId + seq`, it is deduplicated. Ordinary deltas, tool nodes, and authority do not use this bypass.

### 10.1 Live Turns with `turnId + seq`

- Enter the `TurnEventQueue` immediately, not the history buffer.
- After the first REST render, reattach still-active previews to the corresponding `data-anchor=turnId`.
- Authority `messages` and REST history are deduplicated by `uuid/nativeId`.
- Late-join authority still belongs to the strict turn; it is consumed by seq/checkpoint after the REST barrier completes,
  and does not take part in REST array merging as ordinary seq-less history messages.

### 10.2 Seq-less JSONL/TUI Messages

- Come only from external TUI/IDE turns without runtime ownership; Web-initiated runtime turns never take this path.
- Before REST completes, they go into the request-level `historyBuffer`.
- After REST returns, they are merged and deduplicated by `uuid/nativeId`, then the first history render runs.
- Seq-less messages arriving after REST completes go through ordinary incremental history rendering.
- Seq-less messages never enter the turn queue and can neither close nor alter an active streaming turn.

Whichever of REST and WS arrives first must not cause duplicate nodes, overwrite previews, or change tool expanded state.

### 10.3 Status Authority on Initial Load

`bufferAndFetch` records whether the following lifecycle events were actually applied during the REST request:

- `stream_turn_start`: running
- `stream_end`: computed from the remaining outstanding turns
- `permission_request`: keep the turn, but stop the spinner
- `permission_resolved`: computed from the remaining outstanding turns

When lifecycle events exist, the WS status is newer than the REST snapshot; otherwise `/messages.status` is used. Ordinary deltas,
tool input, block start/stop, or authority message fragments cannot independently prove whether a turn has ended, so they never override
the REST status. Only when the endpoint returns no status is a compatibility derivation made from the tail of the merged messages.

## 11. Test Invariants

Must be retained long-term:

- Every permutation of a complete turn is consumed exactly once in seq order.
- Duplicate delivery does not render twice.
- Conflicting seqs are rejected.
- stop/messages/end cannot skip a gap.
- Reordering of large chunks and single characters does not duplicate text.
- Multiple blocks display in creation order.
- A later block must wait for the previous block's reveal to complete.
- Rapidly sending multiple turns still associates each precisely with its own user anchor.
- `seq=1 messages(user)` can resume normal streaming.
- Late join does not show a partial preview lacking a block start.
- A later block start can resume streaming from a node boundary.
- When end arrives early, the whole-turn authority completes it in one pass, and late frames do not reopen the turn.
- REST and strict WS in any order produce only one node.
- REST and seq-less JSONL WS in any order produce only one history message.
- Every Bridge active-turn action carries a valid seq.
- Runtime-owned JSONL user/text/tool-use/tool-result/end are all only persisted and do not produce a second WS stream.
- External TUI/IDE JSONL still sends complete seq-less messages when there is no runtime ownership.
- Trailing tool results of a runtime-interrupted turn that arrive after the terminal record still belong to the same ownership.
- A failed interrupt request does not show Interrupted; a final interrupt is strictly ordered as `OUT → Interrupted → stream_end`.
- Server rejects active-turn events missing turnId/seq.
- DDB does not store live transport fields.

Current core reordering coverage includes:

- all 720 permutations of 6 events
- 500 rounds of random reordering including duplicate delivery
- stop, authority, and end arriving early
- multiple blocks, multiple turns, concurrent REST/WS, and late join
- replay of real Codex large-chunk reordering
