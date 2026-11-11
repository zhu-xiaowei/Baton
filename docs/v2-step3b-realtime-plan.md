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
  and `push` (Bridge → App events). They never change when a method is added. The terminal keeps
  `terminal_direct_data`, the preview `preview_data`.
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

Before deleting, move the side effects of `sync-sessions`:
1. Device registration (the `DEV#` row) → when the Bridge connects.
2. The threads-changed push → stage 2.
3. `lastKnownStatus` is set only after the POST succeeds at most call sites, and the session index
   trusts it first → set it directly.

Also: `checkStopped` takes its candidates from the local index, not `GET /active-sessions`.

Then delete:
- **Bridge:** `sync.mjs` uploads, `uploadMessages` and the startup message sync,
  `realtime-delivery.mjs`, `session-ack-queue.mjs`, `wsSendWithAck` and the HTTP fallback, `noCache`,
  transport truncation (`fitWsPayload`, `recoveryRequired`), `handleSyncSession`,
  `bridge_recovery_complete` (the `epoch` of stage 1 covers it), the rename mirror. The `synced` map
  stays only as the watcher's read cursor.
- **Server:** `/sync-sessions`, `/sync-messages`, `/session-title`, `/delete`, `/active-sessions`,
  `/session-threads`, `/messages`, the message write and relay branches in `bridge_ws.py`,
  `message_history.py`.
- **Infra:** the `BridgeMessages` table; `SESS#` / `PROJ#` rows, both indexes and the stream on
  `BridgeSessions`.
- **App:** what is left of the v1 socket code in `ws.js`, dead `file_ready` / `file_progress`
  branches.

Stays: Connections table, `DEV#` rows, tokens, push devices, the notification event feed.

## Known gaps to fix on the way

- **`agentDetail`:** home cards and the Session list still render it, but the v2 index fills it
  only for daemon agents; `watcher.mjs` already sends the pending prompt's text to DynamoDB
  (`pendingInteractionDetail`), `session-index.mjs` does not read it. Fix with stage 2 (the
  notification needs the same text). Found by reading code, not yet reproduced on screen.
- **Credential expiry:** see stage 1. Not reproduced yet.

## Later (not in this step)

Persistent outbox; prefetch; attachment lifecycle and encryption; FCM for Android; terminal and
preview pairing off Lambda (with the EC2 relay).

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
- Terminal and preview send base64 inside JSON, uncompressed: binary frames and compression before
  encryption. Measure the traffic by type first (`docs/v2-architecture.md` §13).
- Terminal output is sent as it arrives; merging a few milliseconds of it into one frame would cut
  messages on API Gateway too, at the price of that delay. Measure before deciding.

## Workflow

Proposal first, code after confirmation; minimal changes; reproduce before fixing; one PR per stage
(`v2/<feature>` into `feat/v2`), built in order inside the PR: Bridge and server additions, the App
switch, deletions; verify on `BatonV2` in the browser (and on Device Farm when it matters); merge
only when asked.
