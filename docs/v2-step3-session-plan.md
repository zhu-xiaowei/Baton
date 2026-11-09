# v2 Phase 1, Step 3: Session View Served by the Bridge

Status: A implemented (2026-11-09), B to be designed. Context: `docs/v2-architecture.md` §5 (protocol,
Session sequence) and §9 (Session cache).

The Session view reads history from the Bridge over the `app_data` socket that home and lists use;
nothing on the view comes from DynamoDB. Rendering and streaming semantics stay. DDB writes keep
running during step 3 so v1 and v2 can be compared on `BatonV2`; deleting them is M2.

- **A. History**: paging, the App's IndexedDB cache, fetch-on-expand details (this document).
- **B. Real time**: Bridge pushes on `app_data`. A only keeps B unblocked (see the end).

## Protocol

- `history {sessionId, before?, after?, limit = 200, epoch?}` → the newest `limit` rows in the open
  interval `(after, before)`: `{messages, hasMore, oldestTimestamp, epoch, status}` (the former
  `/messages` shape). Cursors are row `orderKey`s (`O2#line#fragment`), opaque to the App.
  - First open: no cursor. Page up: `before`. Re-entry with a cache: `after`. Gap fill: both.
  - `hasMore` with `after`: more than `limit` rows are newer than the cache (a gap).
  - A different `epoch`, or a cursor past the end of the file, returns the latest page with
    `historyReset`; the App drops that Session's cache.
  - A page that reaches the end adds `stableCursor` (where the next `after` starts) and, for Claude,
    `titles` (latest `ai-title` / `custom-title` / `last-prompt` rows, apart from `messages`).
- `threads {sessionId}` replaces `/session-threads` (same shape).
- `tool_details` (direct RPC, no Lambda) returns tool bodies and thinking text (`thinking:<uuid>:<block>`) on
  expand; with `preview: true` the 500-character previews of tools the page left out (a group asks once).
- Existing RPC framing: deflate above 1 KB, 20 000-character chunks, reassembly by `requestId`.

## Page content: only what a collapsed view shows

- Kept: text, prompts, tool name and header inputs (strings ≤ 500 characters), results under 500
  characters (`toolState` reads them for the error / exit-code / cancel colour), Codex status flags,
  `toolUseResult` stats, identity fields (`uuid`, `orderKey`, `stopReason`, `nativeId`).
- Dropped, fetched on expand: truncated result bodies, thinking text (`{type: 'thinking', truncated:
  true}`). Dropped, unread: `codexCommandSource`, Codex inputs `workdir`, `yield_time_ms`,
  `max_output_tokens`, `tty`.
- Claude compaction renders like Codex: `compact_boundary` → "Context compacted", the
  `isCompactSummary` prompt → a collapsed `summary` row.
- A latest page is 16–27 KB on the wire (1–3 frames); a re-entry `after` is ~1.5 KB.

## Bridge

- **Line index** (`history-line-index.mjs`): start/end byte of every line, scanned with
  `Buffer.indexOf` and extended with the new bytes on each request; an unterminated last line is
  indexed provisionally. A new inode, a shorter file or changed bytes before the indexed end rebuild
  it. The epoch is the inode plus the first line (transcripts are append-only, so an in-place rewrite
  that keeps the first line keeps the epoch).
- **Claude reader**: a line is one message, plus one line of lead-in for the meta-prompt rule. Lines
  whose head is a non-message `{"type":"X"` are skipped undecoded. Rows never change, so
  `stableCursor` is the last row.
- **Codex reader**: one card spans several lines, so a window also reads its dependencies, found by
  byte search: lines sharing a `call_id`, the prompt lines of the touched turns, background-process
  starts. They go to the unchanged extractor (`options.lines` + `order`). `reasoning`,
  `token_count` and similar lines are skipped; `compacted` lines are never dependencies. Rows of an
  unfinished turn can change, so `stableCursor` is the row before that turn's prompt.
- **Service** (`history-service.mjs`): Session → file through `sessionIndex` (roots, Claude
  subagents, Codex children). File reads run in one worker (`history-worker.mjs`, one request at a
  time, up to 32 open readers) so they never block streaming; `threads` discovers children there
  too. The first `home` request warms the 10 most recent ∪ active Sessions (cap 20). No page cache:
  a page takes 2–20 ms; the largest files index cold in 0.25–0.7 s.

## App

Call sites keep `api('/api/bridge/messages', …)`; `api.js` maps it to `web/js/v2/history.js`, and
`/session-threads` to `threads`. `FetchBarrier`, `replaceHistoryTail` and rendering stay.

- **Cache** (`history-cache.js`, IndexedDB `baton-history-v1`, account-scoped): one chunk per Bridge
  reply plus a per-Session record (epoch, at most two cached ranges, stable cursor). 200 MB in total,
  least recently opened Session evicted first. Only history replies are stored; tool details stay in
  memory.
- **Re-entry** asks `after: stableCursor`; cached rows after it are replaced by the reply. With a gap
  the newest page shows and scroll-up fills the gap with `before + after`; page-up reads the cache
  first. Recovery paths (foreground, turn end, seq gap) call the same load.
- **Sync phase** `state.wsHistoryPhase`: `''` (in sync or loading), `slow`, `stale`, `offline`.
  Real-time content events wait in the `FetchBarrier` while a load runs and are dropped while
  `stale` / `offline`; the next successful load brings their rows.

| Time | With cache | Without cache |
|---|---|---|
| 0–6 s | Skeleton | Skeleton |
| 6–12 s | Cache (read-only) + top spinner | Skeleton + top spinner |
| Reply | Commit, replay buffered events | Commit, replay buffered events |
| 12 s | `stale`: keep cache; "Request timeout" toast; retry icon | Same, content "<device> is not responding" |
| Offline | Cache + grey dot after the device name | "<device> is offline" + grey dot |

The retry icon reruns the load without the skeleton. A device that rejoins reloads an `offline`
Session by itself. A running Session with no rows yet keeps the skeleton.

## Transport (all v2 requests)

One timer per request. At 6 s with no reply frame it resends once with the same `requestId` (only
missing chunks if some arrived) and tells the page (`onSlow`); it fails at 12 s. The Bridge keeps
encoded replies ~30 s per `requestId`, so a resend never recomputes. Home shows a silent device's
cache at 6 s and toasts "<device> not responding" at 12 s (not while a Session is open).

## What B relies on

- B replaces the v1 real-time sockets and uses A's sync phase, `history {after}` from the stable
  cursor, and the cache for pushed rows; a real-time event for a `stale` Session triggers a retry.
- Pushed rows keep carrying `orderKey`, so pushes, pages and the cache share one cursor.
- Live interrupt rows carry `nativeId: live:interrupt:*`, their JSONL copies do not: reconciliation
  by `uuid` must hold when the history copy has no `nativeId`.
