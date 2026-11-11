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

## Stage 2. Remaining requests and notifications

To design when stage 1 is merged.

- Requests: `list_commands` (catalog in the reply, no S3 copy), `list_command_options`,
  `project_files`, `git_status`, `rename_session`, `create_project`, `delete_files`. Slow ones use
  the `ack` of stage 1. Large file bodies still use S3.
- Pushes that belong to no open Session: title changed, threads changed (today a side effect of
  `sync-sessions`). Needs a device-level subscription or a place on the existing one.
- Notifications: the Bridge emits a notify event on `completed` / `needs_input` with title and
  text from its own data and today's rules applied locally (interrupted turns, pending task
  notifications, the 120 s local-idle rule). The viewer check uses the subscriber table (how
  visibility reaches it is open). The server keeps push devices, the relay call and the event feed
  (Android polling, the iOS extension's fetch). Events raised while disconnected are queued.
- "Not modified" for every read (decided 2026-11-10): the Bridge fingerprints a reply, the App
  sends the fingerprint of its cached answer, and an unchanged answer comes back as a marker
  (measured: `home` 5.7 KB → 0.2 KB; `projects` 0.8 KB, `sessions` 1.5 KB, `threads` 0.6 KB each
  time today). One mechanism in the request layer for `home` (replacing its own revision), the
  lists, `threads`, the command catalog, file listings and Git status. `history` already sends
  only what is newer than the cursor.
- Tool details in IndexedDB (decided 2026-11-10): the content never changes, so no revalidation.
  Least recently opened evicted first, 20 MB in total, nothing above 10 MB stored, no count limit.
- Removes: `ws-rpc.js`, the App's v1 control socket and its ping, the `ROOT#` subscription,
  `notify_check` / `notify_seen`, the command-catalog endpoints, the stream trigger of the
  notification worker, the Subscriptions table.

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
