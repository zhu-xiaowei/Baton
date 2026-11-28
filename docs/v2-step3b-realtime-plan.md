# v2 Phase 1, Step 3B: Real Time on the Direct Channel, No Session Storage in DynamoDB

Status: three stages agreed 2026-11-10; stage 1 implemented on `v2/session-realtime`. Each stage gets
its detailed design here before code. Context: `docs/v2-architecture.md` §4, §5, §8; step 3A is
`docs/v2-step3-session-plan.md`.

## Goal

Everything a Session needs (live events, sends, permissions, the other requests) travels on the
direct App ⇄ Bridge channel (`app_data` ⇄ `bridge_data`), nothing through Lambda that can avoid it;
then the server stops storing Session lists, status and messages.

## Where things are (feat/v2, 2026-11-10)

| | Path today |
|---|---|
| Home, lists, history, threads, tool details | Direct RPC. The App reads nothing from DynamoDB. |
| Session real time: `subscribe`, `messages`, `stream_*`, permission request/resolved, `reveal_permission` | v1 control socket through Lambda; turn events also on the separate `realtime_data` socket (its handshake and target lookup still use Lambda) |
| `send_message` (+ receipt, result), `interrupt`, `permission_reply` | v1 control socket through Lambda |
| Commands (`list_commands`, options), `project_files`, `git_status`, `rename_session`, `create_project`, `delete_files` | v1 control socket through Lambda |
| Server pushes: threads changed, title changed, `notify_check` / `notify_seen` | v1 control socket |
| Terminal, preview | Data direct; pairing on their own control sockets |
| Bridge → DynamoDB | `sync-sessions` (8 call sites), `sync-messages`, `session-title`; `checkStopped` reads `/active-sessions` |
| Notifications | Triggered by the `BridgeSessions` stream; text and interrupt suppression read `BridgeMessages`; viewer check reads the Subscriptions table (`ROOT#<session>` rows) |
| Attachments, images, videos | S3 + presigned URLs through Lambda REST; no DynamoDB |

## Decisions (user, 2026-11-10)

- Three stages, one PR each into `feat/v2`, so no stage needs code for an in-between state:
  **1** Session real time, receive and send together; **2** the remaining requests and
  notifications (after it the App opens no v1 control socket); **3** delete Session storage.
  DynamoDB writes stay until stage 3 for comparison.
- Take everything off Lambda that can go. Terminal and preview pairing stay until the EC2 relay.
- Notifications move to the Bridge; "being viewed" is decided there (details in stage 2).
- Android polling and the notification event feed do not change now (FCM later). Attachments do
  not change.
- Stage 3 deletes the stored history (`BridgeMessages`) outright, with no read-only fallback.
- Everything is on demand: no traffic for a page nobody looks at, connect quickly when needed, and
  nothing here may depend on API Gateway so the EC2 relay can reuse it.
- Deferred, recorded here: persistent outbox in IndexedDB, prefetching Session first pages.

Principle for all stages: **pushes are best effort, `history` is the truth.** The Bridge does not
queue or confirm pushes. A lost one shows as a turn `seq` gap or is covered by the
`history {after}` that follows every (re)subscription.

## Stage 1. Session real time: receive and send

### Wire

- Two routes on the data API share the existing HTTP integration: `rpc` (requests and replies)
  and `push` (Bridge → App events). They never change when a method is added. Terminals and previews
  later moved onto `push` as `stream` frames (`v2/one-socket`), and their own routes were removed.
- The operation is readable in both directions: the signed frame carries a clear `method` /
  `event` next to `action`, and the body the receiver gets carries it too.
- Bodies: `{v: 2, kind: 'rpc', method, requestId, params, replyTo, accept, ack?}`,
  `{kind: 'rpc_result', method, requestId, ok, chunk, enc, data}`, `{kind: 'rpc_ack', requestId}`,
  `{kind: 'push', event, sessionId, id, chunk, enc, data}`.
- Pushes use the reply codec: deflate above 1 KB, 20 000-character chunks, reassembly by `id`. No
  event is truncated for transport, so `stream_end` keeps its messages. A subscriber that cannot
  inflate gets plain chunks.
- Measured with real credentials (Node 20): a 60-character delta is one 1.8 KB frame and 0.2 ms to
  sign; a 115 KB message is one 5.3 KB frame; a 667 KB `stream_end` is three frames (largest
  21 KB) and 5 ms. Without deflate the largest frame is 16 KB. The limit is 28 KiB.
- Requests whose params exceed one frame (a long message) are sent the same way: deflated params in
  chunks, assembled on the Bridge before the handler runs (at most 64 chunks, about 1.2 MB
  compressed). A request that still cannot be signed fails at once (`too_large`).
- Watcher rows over 32 KB still reach the push path as the transport-truncated copy that DynamoDB
  needs today; the App drops them and the history brings the row. This goes with stage 3.

### Subscriptions (Bridge)

- `subscribe {sessionId, renew?, replaces?}` → `{epoch}`. Every subscription pushes the Session's
  waiting permission prompt again (replaces `reveal_permission`; a prompt already on screen keeps
  its state, a lost one reappears within a renewal). A first subscription also lets Codex adopt
  approvals waiting outside the Bridge; a renewal (`renew`) skips that. `replaces` is the caller's
  connection before it reconnected, removed at once. `epoch` identifies the Bridge process.
  Whether the subscriber can inflate comes from the request's `accept`.
- `history {…, subscribe: true}` registers the requester before it reads the file, in one handler,
  so nothing falls between the page and the subscription even when API Gateway reorders frames.
- Table: session → connection id → `{expires, deflate}`. Lease 150 s; the App renews every 60 s
  and sends `unsubscribe` when it leaves the Session or the page is hidden. The lease only covers
  an App that disappears without saying so. Expired entries are dropped on the next publish. The
  server is not involved.
- **Only subscribers receive pushes; the table is the single place that decides.** With no
  subscriber an event is dropped before it is encoded or signed. A `send_message` subscribes its
  sender to the Session (for a new Session, when its id is created), which is how a first turn
  reaches its sender; there is no other delivery rule.

### Catching up on a running turn

- The Bridge keeps the events of each running turn (dropped at `stream_end`; a turn over 1 MB is
  not kept). A `subscribe` (not a renewal) answers with one `turn_replay {sessionId, events}` push
  to that connection, chunked and deflated like any push. The App skips the events it already has,
  so a page that was hidden, lost frames or opened mid-turn shows the turn from its start at once.
- While a turn streams, a history refresh merges new rows instead of replacing the timeline (the
  transcript does not hold the block being written yet). Once the Session is completed, the
  snapshot replaces the partial row as before. A lost frame refreshes with a snapshot and
  resubscribes; the replay rebuilds the turn, and without one it resumes at the next block.
- Before this, returning to the foreground mid-stream cleared the streamed text until the turn
  ended (also on `feat/v2`, where nothing was lost: the refresh replaced the live row).

### What is pushed

- `stream_*`, `messages` (live turn rows and watcher rows), `permission_request`,
  `permission_resolved`: every session event that `wsSend` sees. They no longer go to Lambda,
  except `messages` that DynamoDB still stores (not `noCache`), which also go to Lambda until
  stage 3.
- Turn-local `seq`, `TurnEventQueue`, `FetchBarrier` and the sync-phase rules of 3A are unchanged:
  the App hands every push to the existing `handleWsMessage`.
- No Bridge data socket, or nobody subscribed: the event is dropped.

### Requests: `send_message`, `interrupt`, `permission_reply`

- `send_message` carries today's payload; its reply is today's `send_message_result` (new
  Session id, command output, takeover conflict, errors). The Bridge's send code is unchanged: the
  handler passes `replyTo` as `replyConnectionId` (used only to subscribe the sender) and `wsSend`
  hands the `send_message_result` for that `turnId` to the waiting request. Repeats of a `turnId`
  get the same result.
- The result can take seconds (Claude start-up, attachment downloads), so the request asks for a
  receipt: with `ack: true` the Bridge answers `rpc_ack` on arrival. The ack shows the bubble and
  clears the composer (replaces Lambda's `send_message_received`) and extends the request's
  deadline from 12 s to 60 s. Without a receipt the request is sent again every 3 s.
- A send that fails before its ack is sent again when the device or the socket comes back, within
  the existing 12 s window; after that the existing rollback / "Not delivered · Retry" applies.
- `interrupt` and `permission_reply` return `{ok}`. If a permission reply is lost, the prompt is
  still waiting on the Bridge and stays on screen.

### App transport (`direct-transport.js`)

- `onPush(listener)`; a subscription registry that subscribes again after every `whoami`, when the
  device comes back, and on each keepalive tick.
- `onResync(device)`: after a reconnect, a device coming back, or a changed `epoch`. The Session
  view answers with its existing refresh (`history {after}`).
- Dead socket: a request with no inbound frame for 3 s pings the socket and rebuilds it after 3 s
  more of silence (a shorter wait rebuilds live sockets on slow networks); the new `whoami`
  resends what is pending. This replaces the send probes of `ws.js`.
- Reconnects continue while the page is visible and a request or a subscription needs the socket
  (today they stop after four drops).

### Keepalive and connection lifetime

- One 60 s tick while the page is visible: the subscription renewal when a Session is open
  (an end-to-end check through the Bridge), otherwise the gateway ping. The 25 s ping of v1 existed
  because its receive-only socket had no other way to notice a dead connection; here late
  requests, `seq` gaps and foregrounding all probe at once, so the interval only bounds how long a
  silently dead socket goes unnoticed while the user just watches (about a minute).
- Hidden page: the App unsubscribes at once and stops the tick, so the Bridge stops pushing (the
  lease is the fallback when the unsubscribe cannot be sent); the gateway closes the idle socket
  after 10 minutes, and a hidden page reconnects only for a request in flight. Foregrounding
  reconnects, subscribes and refreshes, as it already does.
- A `seq` gap pings this socket; the pong plus 3 s means the frame is lost (was: both v1 sockets).
- The v1 control socket keeps its own ping until stage 2 removes it.

### Credentials

- Bridge: `direct_rpc {op: 'credentials'}` on its control socket returns the data-API credentials
  (1 h). It asks at start and again before signing when under 5 minutes remain; frames wait for
  that answer. No timer.
- App: before signing, with under 5 minutes left it loads `/devices` (which issues new credentials
  once under 10 minutes remain) and then sends.
- Why it changes: the App never renews today (a page visible and idle for an hour then fails every
  request), and the Bridge's credentials come from the `realtime_direct` hello that this stage
  deletes.
- Reproduced on `feat/v2`: with credentials past their expiry a request is never sent and fails
  at 12 s. Tested with a simulated expiry only: the transport test, and one `BatonV2` run on a
  test-only build that reports a 60 s expiry (STS cannot issue less than 15 minutes), which
  exercises App, Bridge and server together.

### Session view (`ws.js`)

- `subscribeSession` / `adoptNewSession` / `selectWsSession` use the direct subscription. The
  control socket keeps only `subscribe {sessionId: 'ROOT#<root>'}` for the notification viewer
  check, until stage 2.
- Sends, interrupts and permission replies call `request`; the result handler is the existing
  `send_message_result` branch.

### Removed in stage 1

- Bridge: `realtime-direct.mjs`, `realtime-direct-protocol.mjs`, the `send_message` /
  `permission_reply` / `reveal_permission` / `interrupt` cases on the control socket.
- Server: `realtime_direct_ws.py` and its hooks, the `realtime_direct_data` route and
  integration, the relays for `send_message` (+ receipt, result), `permission_reply`, `interrupt`,
  `reveal_permission`, `permission_*` and `stream_*`.
- App: the `realtime_data` socket and `RealtimeReceiver`, Session `subscribe` / `unsubscribe` /
  `reveal_permission` through Lambda, `send_message_received`, the transport retry and send probes.
- `docs/realtime-direct.md` and the three realtime-direct test files.

### Verification (2026-11-10, `BatonV2`, Chromium, browser in us-east-1, stack in Tokyo)

- Transport tests against a real `DirectRpcBridge`: receipt and long request, unreceipted resend at
  3 s, a socket that swallows frames (rebuilt at 6 s), expiring credentials on both sides, pushes to
  subscribers only, a multi-chunk push, resubscription after a reconnect and a Bridge restart.
- In the browser, Claude and Codex: new Session, follow-up, AskUserQuestion prompt, interrupt; no
  Session event on the control socket. A second viewer, a hidden page (no push, no frame sent), a
  socket dropped mid-stream, a socket that swallows frames, a Bridge restart and a send while the
  Bridge is away all end with complete content and one copy of each message. A half-answered
  two-question prompt keeps its state when the Bridge pushes it again. Without `DecompressionStream`
  the same flows work on plain chunks.
- Medians from click, against the `feat/v2` build on the same stack: bubble shown 251–259 ms
  (was 228–231, the receipt now comes from the Bridge, not from Lambda), Bridge result 252–258 ms
  (was 417–420); first stream frame unchanged (the model decides it). Interrupt to `stream_end`
  about 0.3 s. With a simulated 60 s credential expiry an idle page opens a Session in 1 s
  (`feat/v2`: no frame sent, failure at 12 s).
- Not run: WebKit, the native shells, a real one-hour expiry.

## Stage 2a. The remaining requests and pushes; no v1 control socket

Decided 2026-11-11. After it the App opens no v1 control socket (the terminal opens its own for
its pairing, as it already can). Notifications are stage 2b.

### Shared request behaviour

- **Long requests:** a handler still running after 5 s sends `rpc_progress {requestId, progress?}`
  every 15 s; each one moves the App's deadline to 60 s after it (as MCP and LSP progress
  notifications do). Git push and commit (up to 120 s), downloads and video uploads to S3 (up to
  30 min) and deletes need nothing else; `progress` carries what a page shows (delete counts).
- **Concurrency:** only the reads that use the machine (history, threads, tool details, file
  listings and reads, Git status / diff / refs / history / commit files) count, at most 6 at once.
  Everything that waits (sends, interrupts, permission replies, subscriptions, commits, pushes,
  uploads, deletes) runs at once. Traffic is the same either way; only waiting time changes.
- **Not modified:** a request may carry `known: <fingerprint>`; the reply carries `fingerprint`
  (SHA-256 of the result, 16 hex digits) or, when it equals `known`, only `{notModified: true}`.
  Used by `projects`, `sessions`, `threads`, file `list` / `browse` and Git status / refs /
  history. `home` and `list_commands` keep their own revision, which already answers "not
  modified" without computing the whole result.
- Replies use the reply codec (deflate, chunks, no size limit). The file and Git handlers keep
  producing their frames (`bridge/project/ws-frames.mjs`); the Bridge collects them into one
  result `{frames}` and forwards progress frames as `rpc_progress`, so the App's assemblers stay.

### Requests

| Request | Notes |
|---|---|
| `list_commands` | The catalog in the reply; no S3 copy (largest real catalog: 105 commands, 29 KB, 9 KB deflated) |
| `list_command_options` | Gets a deadline (none today) |
| `project_files` `list` / `browse` / `read` / `download` | One result; images, videos and downloads still go through S3, kept alive by progress |
| `git_status` (every operation) | One result; diff paging stays |
| `rename_session` | The reply carries the new title; the DynamoDB mirror stays until stage 3 |
| `create_project` | A request id and a deadline (today matched by path, no timeout) |
| `delete_files` | Progress through `rpc_progress`; the App's `/api/bridge/delete` stays until stage 3 |

`request_file` / `file_ready` / `file_progress` have no sender any more and are deleted.

### Pushes

- **Threads changed:** the Bridge pushes `session_threads_changed {deviceName, roots}` to the
  connections subscribed under that root when its child counts change. `subscribe` carries the
  root (`history {subscribe}` too).
- **Title changed:** the requester gets the title in the reply; the Bridge pushes
  `session_title_changed` to the Session's and its root's subscribers. List pages see it the next time they load (cheap
  with "not modified"). Before, the server broadcast it to every page of the account.

### Also in 2a

- Tool details in IndexedDB (decided 2026-11-10): least recently opened evicted first, 20 MB in
  total, nothing above 10 MB stored, no count limit.
- `agentDetail` in home and lists from the Bridge's pending prompt.
- `history {subscribe: true}` does what `subscribe` does on opening (re-push the waiting prompt,
  replay the running turn, return `epoch`), so opening a Session sends 2 requests instead of 3.

### Accepted until 2b

The server's "being viewed" check (`notify_check` / `notify_seen`) has no App to ask, so while you
watch a Session on one device another device still gets its push (a foreground iOS / Android app
still suppresses its own open Session). The Subscriptions table and the notification worker are
left as they are; 2b removes both checks into one on the Bridge.

### Removed in 2a

- App: the control socket in `ws.js` (connect, probes, 25 s ping, send queue, `ROOT#`,
  `notify_seen`, `sync_complete`, `bridge_recovery_complete`) and the command catalog's S3
  download. `ws-rpc.js` stays as the frame assembler, now over `bridge.request`.
- Bridge: the catalog upload, the legacy file request, the control-socket cases of the moved
  actions.
- Server: the `server/src/project/` relays, the relays of `list_commands`,
  `list_command_options`, `create_project`, `delete_files`, the threads-changed broadcast and the
  command-catalog endpoints with their S3 code. The `subscribe` / `notify_seen` routes and the
  Subscriptions table stay for 2b.

## Stage 2b. Notifications from the Bridge

Designed 2026-11-11, after `main` (#197) was merged into `feat/v2`. The Bridge decides and words
every alert and checks "being viewed" itself; the server only stores the event and pushes it.
Old Bridges are not supported (they update with the stack).

### Flow

1. **Where alerts are decided.** Every status write already goes through `post('/api/bridge/sync-sessions')`
   (`bridge/http.mjs`); about ten call sites (watcher, pool, `checkStopped`, agent poll, Codex). The
   notifier observes those rows there, keeps the previous row per Session (the server's old image:
   rows are written whole; `threadRootId` and child counts carry over when omitted) and runs the
   worker's rules on old → new. The first row of a Session after a Bridge start is only a
   baseline, as a new DynamoDB row was. In stage 3 the observation point stays when the POST goes.
2. **Rules** (unchanged from `notification_worker.notification`, including #197): only root rows;
   `localIdleSec < 120` skips; `needs_input` alerts when entered or when its question changes;
   `completed` alerts after `running`, or after a held Done whose agents are gone; held while
   `backgroundAgents`. Title, folder name and body (`✅ Done · …`, `🟡 Needs input · …`) as today.
3. **Done text** from the Bridge's own history (`historyService`, the latest 20 rows, up to 3 tries
   1 s apart because the final reply may land after the status): no alert after `[Request
   interrupted`, or when a `<task-notification>` row came before any reply; a slash command's
   `<local-command-stdout>`; else the last assistant text once an `end_turn` row is seen. Claude
   and Codex rows have the same normalized shape.
4. **Being viewed.** The Bridge pushes `notify_check {rootSessionId, eventId}` to the connections
   subscribed under that root (`targets(root, {root: true})`) and waits **3 s** (one App ⇄ Bridge
   round trip measured 200–250 ms; the transport's own stall limit is 3 s). The App answers with a
   `notify_seen {eventId}` request only when the page is visible, focused and shows that root; any
   answer suppresses the alert. No subscriber: no wait. A suspended iOS socket keeps its lease but
   cannot answer, so its alert goes out.
5. **Delivery.** `POST /api/notifications/events {alert}` on the API Lambda (next to the feed it writes): the server takes the account
   from the key, assigns the feed key at receipt (`EVENT#<now ms>#<eventId>`; Android's cursor only
   moves forward, so a queued event must not keep its old time), writes the feed row and calls the
   push relay for the account's iOS devices, as `deliver()` does now.
6. **Offline queue.** A POST that fails (no response or 5xx) is queued: the newest per Session, at
   most 10, dropped after 10 minutes; retried every 30 s. A request
   that reached the server but lost its answer may alert twice (iOS replaces it by collapse id).

### Changes

| Part | Change | Estimate |
|---|---|---|
| `bridge/notify.mjs` (new) | rules, Done text, `notify_check` / wait, queue, POST | +170–200 |
| `bridge/http.mjs`, `bridge/ws.mjs` | observe `sync-sessions` rows; `notify_seen` request handler | +20 |
| App (`ws.js`) | answer `notify_check` | +10–15 |
| Server | `POST /api/notifications/events` with `deliver` / `send_apns` / `relay` moved into `notifications.py`; delete `notification_worker.py` and the WS `subscribe` / `unsubscribe` / `notify_seen` handlers | +40 / −220 |
| Template | delete `NotificationWorker`, its role, logs and stream mapping, `SubscriptionsTable` and the `SUBSCRIPTIONS_TABLE` / `WS_API_ENDPOINT` uses for it; the API role may invoke `*-apns` | −80 |
| Tests | the rule cases move to a Bridge test; one server test for `/notify`; the worker and subscription tests go | +110 / −250 |

`backgroundAgents` and `localIdleSec` stay in the `sync-sessions` rows until stage 3: the notifier
reads them from the same rows.

### Done (2026-11-11)

Verified on BatonV2 (`1.1.0-10c88fb5-s2b1`, Chromium, reading the event feed as Android does):
Done after leaving the page (`✅ Done · notify-a`); nothing while the page is open and focused
(`notify_check` push → `notify_seen` request); `🟡 Needs input · Tea or coffee?` when the question
arrives after leaving, and nothing when it arrives while viewing; nothing for an interrupted turn;
one Done for a turn with two background agents (`✅ Done · all-done`). Not run live: the iOS relay
leg (no iPhone registered on the test stack) and the offline queue (unit test only).

### Planned verification

BatonV2 with the TestFlight build (Device Farm's public iOS devices strip the push entitlement)
and Android: Done and Needs input arrive with today's text; a subagent session alerts once; an
interrupted turn does not alert; nothing while the Session is open and focused on another device;
an alert after the iOS app is suspended with the Session open; queued alerts after the Bridge was
offline.

## Stage 3. Delete Session storage in DynamoDB

Planned 2026-11-11 from a full inventory of the readers and writers (below). Stage 2b is merged
(#200). One PR, commits ordered: the Bridge stops writing → server and infra deletions → App →
tests → docs. No compatibility for old Bridges (they update with the stack); `BridgeMessages` goes
with no read fallback.

### Decisions (confirmed 2026-11-11)

Rule: what v2 does not need logically is deleted (add it back if something breaks); what it still
needs stays. The only v1/v2 guard left is the App's `protocol !== 2` check on `/devices`
(`web/js/v2/home.js`). Old native App builds are not a concern (the App is upgraded first).

1. **Device rows are written by `$connect`.** The Bridge adds its display name and os to the
   control-socket URL; the WS Lambda puts `pk DEVICE#<account>`, `sk <device>` in `SystemTable`
   on every Bridge connect. `/devices`, `/device-name/validate` and `/delete-device` read it.
   No new endpoint; `BridgeSessions` is deleted whole. A device offline at deploy time appears
   again when it next connects.
2. **One local outlet** `reportSessions(body)` replaces every `sync-sessions` POST: it sets
   `lastKnownStatus` and calls `observeSessions` (the hook moves out of `http.mjs`).
3. **Cursors advance without a POST.** The retries that existed for failed POSTs go: the Claude
   file-queue backoff, `_firstSyncs`, Codex `scheduleRetry`.
4. **`checkStopped` candidates are local** (`lastKnownStatus` running/needs_input; project from the
   session index, Codex keeps its catalog project).
5. **Live rows publish straight to subscribers**; ack queue, HTTP fallback, `noCache`,
   `fitWsPayload`, `truncateToBytes`, `DDB_ITEM_LIMIT`, `MAX_POST_BYTES` go.
   **`recoveryRequired` goes** (Bridge flag + the App's reads of it; `scheduleTurnEndRecovery`
   stays for the dropped-live-rows path). In v1 it repaired transport truncation. Checked with
   CC 2.1.322 headless, Bridge arguments, stdout vs JSONL per turn (`.scratch/stage3-verify/`):
   plain reply, tool call, killed mid-turn: every JSONL row was on stdout; `/compact`: only its
   command echo row was not, in a turn that has other rows (the flag would not fire).
6. **Startup always baselines cursors to EOF** (today's `--skip-init`, free: `_lineCount` is
   known), otherwise a known Session's first change replays its whole JSONL to subscribers.
   `synced.json` persistence and its legacy decoding go (the cursor map stays in memory).
7. **Activity throttle goes** (`session-activity.mjs`, `forceActivity`): added in 347cc09c to
   refresh DynamoDB `lastActive` every 30 s while rows arrive without a status change; v2 lists
   read file times from the session index. Codex status scans keep their own triggers
   (`task_started` / `task_complete` / `turn_aborted` / `user_message`).

### Deleted (inventory, 2026-11-11; about 4,100 lines)

- **Server (≈1,250):** `bridge_sync.py` `/sync-sessions`, `/sync-messages`, `/session-title`,
  `/delete` and helpers; `bridge_read.py` `/active-sessions`, `/session-threads`, `/messages` and
  helpers; `bridge_ws.py` `messages`, `messages_ack`, `sync_complete`, `bridge_recovery_complete`,
  `notify_bridge_sync`, turn-sequence checks; `message_history.py`; `clear-sessions-table.py`,
  `backfill-message-ttl.py`. `/delete-device` keeps `device_removed`.
- **Template (≈90):** `BridgeSessionsTable`, `BridgeMessagesTable`, their env vars and grants; the
  unused WsApi `realtime_ping` MOCK route (App and Bridge ping only the direct API). Adds the WS
  Lambda's `SystemTable` grant.
- **Bridge (≈680):** `realtime-delivery.mjs`, `session-ack-queue.mjs`, `session-activity.mjs`,
  `uploadMessages`, `uploadCatalog`, startup message sync, `handleSyncSession`, the adapters'
  `shouldSkipInitial` / `syncInitialMessages` / `syncAllMessages`, `--skip-init`, the rename mirror
  and its `synced` reply field, `bridge_recovery_complete`. `refreshClaudeSubagents` keeps its
  count carry-over (`notify.mjs` relies on the same rule).
- **App (≈60):** `/api/bridge/delete` after `delete_files`; the path aliases in `api()` (callers
  use `loadHomeV2` / `requestFresh` / `loadLatestHistory` directly); `recoveryRequired` reads;
  the token-less setup fallback (`entry-setup.js`); the v1 list-cache key migration; `legacyGear`;
  the `baton-nav` cleanup; the `synced` rename field.
- **Tests (≈1,570 deleted, ~20 cases rewired):** whole files `session-ack-queue`,
  `test_message_history`, `payload-sizing`; most of `test_bridge_runtime.py`; storage cases in
  `session-catalog`, `claude-watcher-routing`, `claude-agent-status`, `runtime-adapter`,
  `tool-preview`, Codex `watcher` / `session`, `e2e.mjs`; `recoveryRequired` cases; frontend tests
  that call the removed `api()` aliases. Cases asserting POST bodies move to the local outlet;
  `notify.test.mjs` unchanged.
- **Docs (≈520 deleted, ≈270 rewritten):** mainly `docs/api.md`, `claude-code-bridge.md`,
  `codex.md`, CLAUDE.md; smaller edits in `headless-streaming.md`, `streaming-render-design.md`,
  `frontend-patterns.md`, `session-rename.md`, `tool-preview.md`, `v2-architecture.md`,
  `mobile-notifications.md`, `message-history-merge.md`, `claude-commands.md`.

Kept on purpose: CLI-version handling of local files (old Codex rollouts and prompts, older CC
without session records, `legacyTurnUserOccurrenceKey` for current `codex:turn:*:user` IDs);
install/upgrade migration (`--key` rewrite, Windows old-process stop, `/api/install`); the
new-Session result match by `turnId` (some results carry no `requestId`); terminal `themeUpdates`
(it tells the two terminal implementations apart).

Stays: Connections table, `SystemTable` (tokens, push devices, the notification feed, device
rows), attachments in S3, `/devices`, `/device-name/validate`, `/delete-device`,
`/api/notifications/*`, heartbeat.

### Detailed design

One PR `v2/stage3` → `feat/v2`, five commits in this order; each leaves the suites green.

**Commit 1 — Bridge stops writing (≈ −680 / +60)**
- `sync.mjs`: `reportSessions(config, sessions, extra)` builds the former `sync-sessions` body
  (`deviceName`, `os`, `sessions`, optional `agentCountUpdates`), sets `lastKnownStatus` per row and
  calls `observeSessions(body)`; sync, no network. `syncSessions` keeps discovery,
  `rebuildAgentCounts`, `recentSessions` / `lastKnownStatus` seeding, and always runs
  `baselineToEnd` (no message sync, no `uploadCatalog`). `checkStopped(config, index)`: candidates
  are `lastKnownStatus` entries with running / needs_input; project, preview and lastActive come from
  `index.catalog()` roots when present (Codex children and roots without a row are inspected from
  their file), `active.status` = the known status; results go to `reportSessions`.
- Every `postFn('/api/bridge/sync-sessions')` / `postRequired(...)` (watcher ×3, both runtimes'
  `updateSessionStatus`, Codex `syncMetadata`, `checkStopped`) → `reportSessions`; `postFn` options
  are dropped. `http.mjs` loses the `observeSessions` hook and `postRequired` / `get` if unused.
- `watcher.mjs`: rows of runtime-owned turns are skipped (not uploaded); `historyComplete` uploads,
  `_firstSyncs`, the file-queue backoff and `forceActivity` go; watermark set after the pass.
- `codex-watcher.mjs` + `codex-extract.mjs`: `syncCodexMessages` becomes extract + watermark; the
  uploader's persisted-only branch drops rows, the rest publish; `scheduleRetry` / `clearRetry`,
  `uploadFn`, `postFn`, `forceActivity` go.
- `realtime-delivery.mjs` → a ~10-line `publishMessages(sessionId, messages, { turnId })` in `ws.mjs`
  (tool previews, turn event when a live turn exists, else plain `messages`), via `wsSend`.
- `ws.mjs`: `wsSend` publishes Session events only (no fall-through to Lambda for `messages`, no
  `recoveryRequired`); delete `fitWsPayload` (remaining Lambda frames are small: heartbeat, terminal,
  preview; oversize → log + drop as today), `SessionAckQueue` / `wsSendWithAck`, `handleSyncSession`
  and the `sync_session` / `messages_ack` cases, `noCache` options; connect URL gains
  `&name=<display>&os=<platform>`.
- `extract.mjs`: delete `uploadMessages`, `truncateToBytes`, `loadSynced` / `saveSynced` /
  `decodeSyncedState` (the `synced` Map stays in memory). `config.mjs`: `MAX_POST_BYTES`,
  `DDB_ITEM_LIMIT`, `WS_FRAME_LIMIT` (if unused), `--skip-init`. `bridge.mjs`: `--skip-init` and
  `bridge_recovery_complete`. Runtimes / `runtime-adapter.mjs`: `shouldSkipInitial`,
  `syncInitialMessages`, `syncAllMessages`. `session-rename.mjs`: the `/session-title` mirror and
  `synced`. `live-turn-stream.mjs` / `live-execution-stream.mjs`: `noCache`. Delete
  `session-ack-queue.mjs`, `session-activity.mjs`.

**Commit 2 — server and template (≈ −1,340 / +40)**
- `bridge_ws.py` `_handle_connect`: after a successful Bridge claim, `put_item` into `SystemTable`
  `{pk: DEVICE#<account>, sk: <device>, deviceName, deviceDisplayName, os, lastConnected}`.
  Delete `messages` / `sync_complete` / `bridge_recovery_complete` handling, `_handle_bridge_messages`,
  `_handle_sync_complete`, `_handle_bridge_broadcast`, `notify_bridge_sync`,
  `_runtime_session_fields`, turn-sequence checks, `_messages_table`.
- `bridge_read.py`: `/devices` and `/device-name/validate` query `DEVICE#<account>`; delete
  `/active-sessions`, `/session-threads`, `/messages` and their helpers / constants.
- `bridge_sync.py`: delete `/sync-sessions`, `/sync-messages`, `/session-title`, `/delete` and their
  models / helpers; `/delete-device` disconnects, then deletes the device row.
- Delete `message_history.py` (+ Dockerfile line), `clear-sessions-table.py`, `backfill-message-ttl.py`.
- Template: delete both tables, `BRIDGE_*_TABLE` env vars, their IAM resources, the WsApi
  `realtime_ping` route / integration / responses; WS Lambda gets `SYSTEM_TABLE` + grant.

**Commit 3 — App (≈ −60 / +15):** `api()` aliases out, call sites call `loadHomeV2` /
`expandedHome` / `requestFresh` / `loadLatestHistory` / `loadOlderHistory` (app.js, ws.js,
index.html); `recoveryRequired` reads; `/api/bridge/delete`; `entry-setup.js` token-less fallback;
list-cache v1 migration; `legacyGear`; `baton-nav`; rename `synced`; stale comments.

**Commit 4 — tests (≈ −1,570):** as in the inventory; rewired cases assert `reportSessions` output
(spy on `observeSessions` / `lastKnownStatus`); one new Bridge case: startup baselines every
catalogued Session to EOF.

**Commit 5 — docs (≈ −520, ≈ 270 rewritten)** plus this plan doc.

### Verification

Local suites (Node 20). BatonV2 deploy `1.1.0-<sha>-s3a`: the existing e2e scripts
(`.scratch/v2-stage1/e2e` chat / resilience, `.scratch/v2-stage2a/e2e` basic / repeat / threads /
notify) plus rename, delete, a device row appearing after the Bridge reconnects, `/device-name/validate`
from the install script, and device removal on a throwaway device (a second Bridge connection under
another name, so `test-ec2-ap` is not uninstalled). CloudWatch: no `sync-*`, `session-title`,
`active-sessions` or `messages` requests after the deploy; both tables gone from the stack.

## Known gaps to fix on the way

- **`agentDetail`:** home cards and the Session list still render it, but the v2 index fills it
  only for daemon agents; `watcher.mjs` already sends the pending prompt's text to DynamoDB
  (`pendingInteractionDetail`), `session-index.mjs` does not read it. Fix with stage 2 (the
  notification needs the same text). Found by reading code, not yet reproduced on screen.
- **Credential expiry:** see stage 1. Not reproduced yet.

## Later (not in this step)

Persistent outbox; prefetch; attachment encryption; FCM for Android. (Terminal and preview pairing
moved off Lambda in `v2/one-socket`: both are `stream` frames on the App's one direct socket.)

Traffic, to settle with the EC2 relay and end-to-end encryption (bytes are billed there; API
Gateway bills per message, so none of this saves anything today except the last item):
- Push envelope: a 30-byte delta is a 471-byte frame. Without duplicated fields and JSON inside
  JSON it is 283 bytes; with short per-subscription references for session and turn, 133. The
  clear envelope is redefined by encryption anyway, so it is designed once, then.
- The SigV4 fields (about 1.5 KB on every frame) disappear on the relay.
- Subscription renewals (decided 2026-11-11): while a Session is open and visible the App renews
  its lease every 60 s (about 1.5 KB out, 0.2 KB back; it doubles as the keepalive), only because
  API Gateway never tells the Bridge that an App socket closed. The relay knows, so it tells the
  Bridge on a disconnect; renewals, leases and `replaces` then go, and the keepalive is the plain
  ping. Until then the renewal stays as it is (on API Gateway a ping costs the same two messages).
- Terminal and preview data are deflated when that pays (`v2/one-socket`); binary frames come with
  the relay and encryption.
- Terminal output is merged every 16 ms (`v2/one-socket`), about 60 messages a second at most.

## Workflow

Proposal first, code after confirmation; minimal changes; reproduce before fixing; one PR per stage
(`v2/<feature>` into `feat/v2`), built in order inside the PR: Bridge and server additions, the App
switch, deletions; verify on `BatonV2` in the browser (and on Device Farm when it matters); merge
only when asked.
