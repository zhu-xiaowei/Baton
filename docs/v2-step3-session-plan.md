# v2 Phase 1, Step 3: Session View Served by the Bridge

Status: design (2026-11-09). Base: `feat/v2` at `7fdc09f` (step 2). Context: `docs/v2-architecture.md`
§5 (protocol, Session sequence) and §9 (Session cache).

## Goal and phases

The Session view reads history and real-time events from the Bridge over the `app_data` socket that
home and lists already use; nothing on the view is read from DynamoDB. Rendering and streaming
semantics stay as they are. DDB writes keep running during step 3 so v1 and v2 can be compared on
`BatonV2`; deleting them is M2.

- **A. History**: paging, the App's IndexedDB cache, fetch-on-expand details (this document).
- **B. Real time**: Bridge pushes on `app_data` (subscribe, turn stream, permissions, sends). Designed
  after A; A only has to keep B unblocked (see the end).

## A1. Protocol

- `history {sessionId, before?, after?, limit = 200, epoch?}` returns the newest `limit` rows in the
  open interval `(after, before)` as `{messages, hasMore, oldestTimestamp, epoch, status,
  stableCursor}`, the former `/messages` shape plus the cursor for the next `after` (A4). The cursor is the row's `orderKey` (`O2#line#fragment`), opaque to the App.
  - First open: no cursor. Page up: `before`. Re-entry with a cache: `after`. Gap fill: both.
  - `hasMore` with `after` means more than `limit` rows are newer than the cache: the App shows the
    newest page and fills the gap later with `before + after`.
  - `epoch` identifies the file (device + inode + birth time). A different epoch, or a file that got
    shorter, returns a fresh latest page and the App drops that Session's cache.
  - The latest page also carries the current title rows (`ai-title`, `custom-title`, `last-prompt`).
- `threads {sessionId}` from the session index replaces `/session-threads`.
- `tool_details` serves every tool body and thinking text on expand (today only Edit).
- Responses use the existing RPC framing: deflate above 1 KB, 20 000-character chunks, any-order
  reassembly by `requestId`. A page is 1–3 frames.

## A2. Page content: only what is visible

Tool cards and thinking are collapsed by default (`tool.js` `historyCollapsed`), so a page carries
what a collapsed view shows; bodies come from `tool_details` on expand.

- Kept: text, prompts, tool name and header inputs (strings ≤ 500 characters, nested objects kept),
  results shorter than 500 characters (`toolState` reads them for error / exit code / cancel colour),
  status flags (`codexExitCode`, `codexProcessId`, `codexBackground`, `codexWait`, `codexMcp*`,
  `codexProvisional`, `codexSuperseded`, `codexCommandKind/Actions/Command`), `toolUseResult` stats,
  and every identity field the frontend uses (`uuid`, ids, `orderKey`, `stopReason`, `nativeId` when it
  differs from `uuid`).
- Dropped: truncated result bodies (`truncated: true`, fetched on expand), thinking text (`{type:
  'thinking', truncated: true}`), `codexCommandSource`, Codex inputs `workdir`, `yield_time_ms`,
  `max_output_tokens`, `tty` (no frontend reader).
- Not done, measured as not worth it: shortening field names (<1 % after deflate), headers to 300
  characters (+0.7–1.5 KB only), omitting summaries of hidden tool-run group members (0.7–1.4 KB, and
  the Bridge would have to mirror `tool-run-group.js`).
- Claude compaction renders like Codex: `system/compact_boundary` → a `system_event` "Context
  compacted", the `isCompactSummary` prompt → a collapsed `summary` row (today it is dropped on
  startup sync but shown as a prompt when the watcher delivers it).

## A3. Bridge structure

A `history` capability on the existing runtime adapter (`defineRuntimeAdapter`). Each runtime
implements one reader; everything else is shared.

- **Reader (per runtime)**: `update()` (index new bytes), `latest(limit)`, `before(cursor, limit)`,
  `after(cursor)`. Readers return rows in the current API shape; they never hold a whole transcript.
- **History service (shared)**: Session → file via `sessionIndex`; reader LRU; page cache of
  prepared rows; warm-up; visible-only slimming and encoding; worker thread; epoch and cursors.
- **Line index (shared)**: start/end byte of every line, built with `Buffer.indexOf` in 8 MB chunks
  (no decoding), extended with the new bytes on each request. An unterminated last line is indexed
  provisionally and rescanned. Inode change or a shorter file rebuilds the index and changes the
  epoch.

### Claude reader

- A line is one message; the frontend pairs `tool_use` and `tool_result`. The only cross-line rule
  (a meta prompt hides the next prompt) needs one line of lead-in.
- Lines starting `{"type":"X"` have top-level type X; non-message kinds (`api-request-blob`,
  `queue-operation`, …) are skipped without decoding.
- A page walks back in 64-line windows until it has `limit` rows.

### Codex reader

- The extractor builds one card from several lines (call, output, completion), so a window must
  contain its dependencies. The index also records, by byte search only: `call_id`s per line,
  `task_started` lines, prompt lines per turn (`user_message`, user `message`, `UserMessage`
  completion), and background-process starts (`Process running with session ID N` ↔ `session_id`).
- Rows for lines `[lo, hi)` = those lines + the turn's `task_started` + every line sharing a
  `call_id` + prompt lines of the touched turns + process-start lines, passed to the **unchanged
  extractor** as a line array with only those line numbers iterated (`options.lines` + `order`).
- Skipped without decoding: `reasoning`, `token_count`, `token_usage_record`, `world_state`,
  `thread_settings_applied`, and `compacted` with an empty message. `compacted` lines are never
  dependencies (their replacement history quotes old call ids).
- A page walks back in windows of 128 → 1024 lines; each window is computed once.

### Lifecycle

| When | Bridge work |
|---|---|
| Start | In a worker, index and prepare the latest page for the 10 most recent Sessions of all runtimes ∪ every running / `needs_input` Session (cap 20) |
| First request | Precomputed: encode only. Otherwise index, then latest page |
| Page up | Read the page's lines (+ Codex dependencies); cache the prepared page |
| Re-entry (`after`) | Index new bytes, read only rows after the cursor |
| File change | Nothing until the next request (it indexes the new bytes) |
| Memory | Indexes (≤ 0.7 MB for a 184 MB rollout) + cached pages (LRU) |

### Measured (warm page cache, `test-ec2`, every local transcript; median / p90 / max in ms)

| Stage | Claude (190 Sessions) | Codex (3073 Sessions) |
|---|---|---|
| Today: full extraction | 4.9 / 64 / 732 | 0.9 / 3.3 / 2160 |
| Index | 1.7 / 4.7 / 20 | 1.7 / 2.5 / 222 |
| Latest page (200) | 2.8 / 10.5 / 50 | 0.9 / 3.2 / 198 |
| Page up | 4.1 / 11.7 / 34 | 14 / 33 / 98 |
| `after` (last 10 rows) | 0.3 / 0.6 / 2.1 | 0.5 / 0.8 / 16 |
| Slim + deflate | 1.3 / 6.4 / 42 | 0.2 / 0.8 / 13 |
| First open, not precomputed | 6.1 / 25 / 57 | 2.9 / 6.9 / 234 |
| Latest page on the wire (≥ 200-row Sessions) | 27 KB (max 44), 2–3 frames | 16 KB (max 25), 1–2 frames |

Cold reads of the largest files: index 250 ms (Claude 92 MB), 731 ms (Codex 184 MB). The slowest
Codex page (198 ms) is 596 lines holding 30 MB of command output, not extra reads. A full extraction
of a 184 MB rollout peaks at ~800 MB RSS; the readers decode only page lines.

### Verification

- Every page of every local Session against a full extraction: Claude 583 pages, Codex 5520 pages,
  0 differences. Append replay with mid-line cuts: 841 + 15 360 appends, 0 differences.
- Against the deployed `/messages` (303 Sessions, 103 078 rows, read with `after=O2#…0`, which never
  triggers `needSync`): 90.6 % identical, order identical everywhere. All differences are v1 data
  that the Bridge reads newer: Codex execution metadata missing in first-seen DDB rows (9 610),
  failed patch attempts the extractor hides (23), rows written before the current preview rules or
  #43 local-command rows (50), interrupt rows with a live `nativeId` (17, relevant to B), Claude
  compaction summaries only stored by the v1 watcher (4).
- Rejected after measurement: cutting long command outputs before `JSON.parse` (no gain, one
  difference).
- App cache logic simulated on growing copies of every transcript (first open at 40 %, re-entry at
  42 %, 95 % and 100 %, then scroll to the top through cache and gap fills): Claude 845 and Codex
  15 150 checks against a fresh read, 0 differences; 54 Codex rows keep their first-seen version
  (execution metadata of background commands, as v1 does). The simulation found the two rules
  above: an empty cursor must fall back to the latest page, and a Codex turn in progress must be
  refetched including its prompt (without it: 739 differences). Claude needs no turn refetch.

## A4. App: cache, request flow, sync state

Call sites keep `api('/api/bridge/messages', …)` and its response shape; `api.js` maps it to
`history`, `/session-threads` to `threads`. `FetchBarrier`, `replaceHistoryTail`, prepend anchoring
and rendering stay. Changes sit in `fetchLatestMessages` / `loadOlderMessages` (cache read, delta,
write-through), the transport, and a small offline UI. `needSync` / `sync_session` / `sync_complete`
handling goes; `loadOlderMessages` passes `device`.

### IndexedDB cache

- Account-scoped database (same helpers as `project-data-cache-idb.js`). `chunks`: one record per
  Bridge response (≤ 200 rows), key `[scope, firstOrderKey]`. `sessions`: per Session `epoch`, cached
  ranges (at most two, merged when the gap closes), confirmed cursor, newest cursor, status at save,
  bytes, last opened. Reading a 200-row chunk takes 0.4–0.8 ms on desktop Chromium (a reverse cursor
  over single rows 4–8 ms); writing 2000 rows as chunks 6 ms versus 52 ms as rows.
- Stored: rows with an `orderKey`, from history responses (confirmed) and from real-time authoritative
  messages (unconfirmed). Not stored: stream previews, `noCache` / `live:*` rows, tool details (those
  stay in the existing in-memory cache).
- Budget 200 MB in total, no per-Session cap; the least recently opened Session is evicted first
  (~0.46 KB per row: 100 Sessions × 2000 rows ≈ 92 MB).
- A different `epoch` drops that Session's cache.

### Request flow

- Re-entry asks `history {after: stableCursor}`. Each reply carries `stableCursor`, chosen by the
  runtime reader: Claude rows never change, so it is the last row; Codex rows of an unfinished turn
  can still change (results get superseded, a prompt can even be retracted), so it is the row before
  that turn's prompt. Cached rows after it are replaced by the reply. No cursor yet → latest page.
  The reply plus the cache form the latest page that `replaceHistoryTail` already handles.
- More than 200 newer rows (`hasMore` with `after`): show the newest page, keep the older cached
  range, fill the gap with `before + after` on scroll-up. Page-up reads the cache first and asks the
  Bridge only for what is missing.
- Recovery paths (foreground, turn end, seq gap) keep calling `loadLatestMessages`; with a cache this
  is a small `after` request.

### Sync state

Each open Session is `syncing`, `synced` or `stale`. Real-time events render only when `synced`;
otherwise they stay in the `FetchBarrier` buffer. This is the contract B builds on.

| Time | With cache | Without cache |
|---|---|---|
| 0–6 s | Skeleton only; events buffered | Skeleton only; events buffered |
| 6–12 s | Show the cache (read-only) and the top loading indicator; keep buffering | Skeleton and the top loading indicator |
| Reply by 12 s | Commit cache + delta as the latest page, replay buffered events in order → `synced` | Commit the page, replay → `synced` |
| No reply at 12 s | `stale`: keep the cache, drop buffered events (the next `after` brings their JSONL rows) | `stale`: the content shows the centred "test-ec2 is not responding" empty state |

Failure looks the same in both cases: a "Request timeout" toast, and the top loading indicator
becomes a retry icon (circular arrow, stroke 1.5, `--action-icon-color`, same 28 / 44 px button as
the other top-bar actions). Tapping it shows the loading indicator again and reruns the entry flow
without going back to the skeleton. Device back online, reconnect and foreground rerun it too.
An offline device shows only the breadcrumb dot (it retries by itself when the device returns); a
timeout on an online device shows only the retry icon.

- Device known offline (`/devices` or the transport's `offline`): no wait. A grey dot sits right of
  the device name in the breadcrumb (only while offline / not responding), the cache shows as is; a
  Session never loaded here shows a centred "test-ec2 is offline" empty state. No dialogs.
- Today a failed fetch replays buffered events onto an empty history; v2 no longer does that.

### Transport (all v2 requests: home, lists, history)

- One timer. At 6 s without any frame of the reply, the transport resends once with the same
  `requestId` and tells the page the request is slow; frames that arrived but left gaps are
  re-requested by chunk instead. The Bridge keeps encoded replies ~30 s per `requestId`: a resend
  during computation is ignored, a resend after sending re-sends the stored frames without
  recomputing. The request fails at 12 s.
- Pages react to those two moments only. Home: at 6 s a silent device shows its cached answer, a
  reply by 12 s updates it through `__applyHome`, otherwise the existing "<device> not responding"
  toast appears at 12 s (today at 6 s). Session view: cache plus top loading indicator at 6 s,
  "Request timeout" toast and retry icon at 12 s.
- Today: a new `requestId` is resent after 2 s even while chunks are arriving (the Bridge recomputes
  and resends everything) and requests fail at 6 s.

### Scope against B

A changes history loading only; v1 real-time sockets stay. B replaces the real-time transport and
adds "a real-time event for a `stale` Session triggers a retry"; it uses A's sync state,
`history {after}` from the confirmed cursor, and the cache write entry for pushed rows.

## What B relies on

- Watcher pushes keep carrying `orderKey`, so pushed rows, history pages and the cache share one cursor.
- Recovery (seq gap, silent turn, turn end) becomes `history {after}` instead of a full reload.
- Live interrupt rows carry `nativeId: live:interrupt:*`; their JSONL copies do not. Reconciliation by
  `uuid` must keep working when the history copy arrives without `nativeId`.

## Tools and workflow

- Prototype and checks in `.scratch/v2-step3/hist/`: `lib.mjs` (readers), `verify.mjs` (every page
  vs full extraction), `replay.mjs` (append replay), `compare-api-full.mjs` (deployed API),
  `summarize.py`. Stack and key for `BatonV2`: `.scratch/batonv2.env`.
- Proposal first, code after confirmation; sub-PRs `v2/<feature>` into `feat/v2`; core tests only;
  test deploys with `APP_VERSION_OVERRIDE` so the test Bridge auto-updates.
