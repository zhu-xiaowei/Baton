# Message History Snapshot and Live Updates

> Status: implemented, updated 2026-09-23
> Scope: Web frontend history loading, background recovery, WS reconnect, in-request event buffering, and live message updates

## 1. Unified Latest-200 Loading

Initial entry, background-to-foreground, WS reconnect, bridge sync, and the compact stream-end follow-up request all share
`loadLatestMessages(sessionId)`. Initial entry shows a skeleton first; other refreshes keep the current page until the request completes.

```text
Set up request barrier → subscribe WS → GET /api/bridge/messages?limit=200
  In flight: buffer raw WS events in arrival order, do not modify the current message DOM
  Success: replace history tail → show snapshot → apply status → replay WS events
  Failure: keep original page → replay WS events
```

Overlapping loads for the same Session reuse the current request. Switching Session invalidates the old barrier, so a late response cannot affect the new page.
The barrier only buffers message/strict lifecycle events; send receipts still go through the original send logic.

New-session takeover and the compact stream-end follow-up request use `{ preserveLive: true }`: they still share the latest-200
request and barrier, but on success merge incrementally by ID, without replacing the history tail, clearing pending, or resetting streaming state,
and keep the existing pagination cursor. A delayed follow-up fetch for an old turn (including an Esc interrupt) must not delete a question or answer sent afterwards.
If the reused request is a not-yet-finished ordinary refresh, that barrier is also upgraded to preserve-live mode.

## 2. Tail Replacement Rules

Let the current message list be `local`, and the up to 200 most recent messages returned by REST be `snapshot`:

1. Take the UUID of `snapshot[0]`; if needed, use a stable native ID to find a unique same-type match in the old list.
2. Boundary found: keep all old messages before the boundary, and replace the boundary and everything after it with `snapshot`.
3. No unique boundary found: use `snapshot` directly. An empty snapshot likewise replaces everything.
4. When the old prefix is kept, keep the original pagination cursor; otherwise use the REST-returned `hasMore` / `oldestTimestamp`.

```text
Old list:    [earlier history] [boundary] [old tail]
REST:                          [boundary] [new tail]
Result:      [earlier history] [full REST snapshot]
```

Only one boundary is matched here: no per-item patching, no bidirectional splicing, no recovery cursor computation, and tail content that had not yet
reached REST before the request is not kept. Normal live updates still need to merge by ID; tail replacement cannot substitute for that.

## 3. Live Messages and Send Order

A successful ordinary snapshot refresh clears optimistic messages and stream previews from before the request started. A failed request clears nothing.
Messages the user newly sends during the request keep their original position and turn-ID anchor; if REST already contains the corresponding echo,
it is confirmed by ID without adding a duplicate user node. When sending 1, 2, 3, 4, 5 in a row, even if completion events arrive in reverse order,
each answer must stay after its corresponding user message; identical text cannot be used as the basis for confirmation.

After the barrier ends, buffered events are handed back one by one to the normal WS entry point:

- Events with `turnId + seq` are ordered, deduplicated, and conflict-checked by `TurnEventQueue`;
- Ordinary watcher messages go through live message commit, not a dedicated recovery commit layer;
- checkpoint / late-join / stream-end authority messages are still handled per the original protocol;
- When a complete message updates live data and the DOM, still-playing stream blocks and user anchors are kept.

Send timeout and manual retry reuse the latest-200 fetch, but only confirm that send's echo, without triggering a full-page refresh.

## 4. Rendering and Scrolling

- When snapshot data is identical and there are no temporary nodes to clean up, the existing DOM is not replaced.
- When the snapshot changes, render once; while reading history, restore position by the first visible message/tool ID and pixel offset.
- When follow is already on, scroll to the bottom of the new content on the next frame; a refresh by itself does not re-enable follow.
- The down arrow disappearing only restores follow intent, without snapping to the bottom immediately; only subsequent visible content changes are followed.
- Tools are collapsed by default in both live and history, and the Edit diff is generated only when expanded.
- Live updates keep the necessary local DOM matching; REST refreshes do not call this local matching.

## 5. Module Responsibilities

| File | Responsibility |
| --- | --- |
| `web/js/ws.js` | Unified REST loading, live commit, send, and lifecycle scheduling |
| `web/js/history-snapshot.js` | Single-boundary tail replacement, viewport anchor save and restore |
| `web/js/fetch-barrier.js` | Request dedup, invalidation checks, raw WS event buffering |
| `web/js/message-state.js` | Live/pagination ID-dedup merge, message index, exact pending confirmation |
| `web/js/message-dom.js` | Live DOM updates, keeping user anchors and stream blocks |
| `web/js/runtime-status.js` | Running-state determination from REST / messages / outstanding turn |
| `web/js/streaming.js` | Turn event ordering, checkpoint, streaming block playback |

The old recovery-specific three-layer modules, generic commit adapter, timestamp incremental cursor, DOM rebinding, and the unconsumed
late-join update cache have been deleted, with no compatibility wrappers kept. Older-message pagination is still a separate `before` request; before committing the response
it validates Session and generation, and is not mixed with the latest-snapshot barrier.

## 6. Verification

```bash
npm run test:frontend
npm run build
node test/browser/history-snapshot-chrome.mjs --headed
```

Unit and integration tests cover boundary match/missing/ambiguous, keeping old pagination, request failure/invalidation, raw WS buffer replay,
consecutive identical-text sends, reverse-order completion, running state, and live DOM stability.

The Chrome test uses an isolated profile and controllable REST/WS, loads the real frontend, and verifies the skeleton, default collapse,
reading position, unchanged snapshot, real tab background/foreground, disconnect recovery, five consecutive sends, compact recovery, and click-to-expand
Edit diff; it does not send test messages to a real Session.

## 7. Codex Updated Plan

Both app-server plan protocols are supported:

- `item/plan/delta`
  - Kept as the legacy/experimental plan text stream;
  - The official protocol explicitly does not guarantee that concatenated deltas equal the final structured plan, so it is not converted into a checklist.
- `turn/plan/updated`
  - Normalized into the same `TodoWrite` model as JSONL `update_plan`;
  - `inProgress` is converted to the frontend status `in_progress`;
  - Identical consecutive snapshots are deduplicated;
  - Rendered live through the strict turn's tool block and authority messages; raw WS events are uniformly buffered during a request.

Both the schema and actual app-server turns of local Codex 0.150.1 verified
`turn/plan/updated { threadId, turnId, explanation, plan }`. Real turns no longer send
`item/plan/delta`; the modified Bridge outputs one complete `TodoWrite` node, and after reload it keeps using the same UI as
JSONL `update_plan`.
