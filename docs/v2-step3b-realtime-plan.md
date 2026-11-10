# v2 Phase 1, Step 3B: Real Time on the Direct Channel, No Session Storage in DynamoDB

Status: plan agreed 2026-11-10. Each step below gets its own detailed design (proposal first, code
after confirmation). Context: `docs/v2-architecture.md` §4, §5, §8; step 3A is
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
| Notifications | Triggered by the `BridgeSessions` stream; text and interrupt suppression read `BridgeMessages`; viewer check reads the Subscriptions table |
| Attachments, images, videos | S3 + presigned URLs through Lambda REST; no DynamoDB |

## Decisions (user, 2026-11-10)

- Order B1 → B5, each a PR (or a few) into `feat/v2`. DynamoDB writes stay until B5 for comparison.
- B3 is in scope: take everything off Lambda that can go. Terminal and preview pairing stay until
  the EC2 relay.
- Notifications must move to the Bridge (B4). "Being viewed" is decided on the Bridge; details are
  discussed in B4.
- Android polling and the notification event feed do not change now (FCM later).
- Attachments do not change in this phase.
- In B5 the stored history (`BridgeMessages`) is deleted outright, with no read-only fallback.
- Deferred, recorded here: persistent outbox in IndexedDB, prefetching Session first pages.

## Steps

### B1. Push channel and real-time receive

The direct channel is request/response only: the App drops any frame without a pending
`requestId`, and the Bridge keeps no subscribers. B1 adds pushes and moves Session events onto them.

To design first:
- **Subscription:** a `subscribe` request; the Bridge keeps session → App connections with an
  expiry (it is not told when an App socket closes). The App resubscribes after every `whoami` and
  when the device comes back. A pending permission prompt comes with the subscribe reply
  (replaces `reveal_permission`).
- **Push frames:** a kind distinct from `rpc_result`; an `onPush` hook in `direct-transport.js`.
  Signed frames are limited to 28 KiB: chunk, or send a truncated copy and fetch the rest
  (`history` / `tool_details`), as oversized rows already do.
- **What is pushed:** `stream_*`, `messages` (Baton turns and watcher rows), permission
  request/resolved. Turn-local `seq` stays, so gap detection keeps working; recovery is
  `history {after}`. A's sync-phase contract stays (events dropped while `stale`/`offline`; an
  event for a `stale` Session already starts a retry).
- **Keepalive:** one scheme on `app_data` instead of v1's 25 s and v2's 60 s; stay connected while
  subscribed (today the socket is not reopened after four drops and is not pinged while hidden).
- **Credentials:** the App refreshes them on demand, right before signing, when they are near
  expiry (they last 1 h and are only renewed after a reconnect or a home load today; no timer).
  The Bridge takes its direct-channel credentials from the `realtime_direct` hello: give it its own
  source and renewal before that channel is removed.
- **Wire action name:** every direct frame is `terminal_direct_data` (one API Gateway route,
  originally the terminal's), with the method inside `body`. Rename it and make the operation
  readable on the wire. One route per operation needs a CloudFormation route each; a neutral route
  plus a clear `method` field needs none. Decide here; the EC2 relay has no such limit.

Removes: the `realtime_data` socket and `RealtimeReceiver`, `realtime_direct` on Bridge and server,
Session `subscribe`/`unsubscribe` through Lambda.

### B2. Send and interaction

`send_message`, `interrupt`, `permission_reply` become requests. The reply is the receipt
(replaces `send_message_received` / `send_message_result`, including the new Session id, queued
and takeover results). Resends are safe: the Bridge already ignores a repeated `turnId`. The
transport's pending-request resend replaces the `wsSendReliable` queue.

### B3. Remaining requests and pushes

- Requests: `list_commands` (catalog returned in the reply, no S3 copy), `list_command_options`,
  `project_files`, `git_status`, `rename_session`, `create_project`, `delete_files`.
- Pushes: title changed, threads changed (today a side effect of `sync-sessions`).
- After B3 a Session page opens no v1 control socket; `ws-rpc.js` goes. Large file bodies still use
  S3.

### B4. Notifications from the Bridge

- The Bridge emits a notify event on `completed` / `needs_input`: title and text from its own data
  (summary from the transcript, the pending prompt's text), with today's rules applied locally
  (skip interrupted turns and pending task notifications, the 120 s local-idle rule).
- Viewer check from the Bridge's subscriber table (to detail here).
- The server keeps push devices, the relay call and the event feed (Android polling, the iOS
  extension's fetch). Events raised while disconnected are queued on the Bridge.

### B5. Delete Session storage in DynamoDB

Before deleting, move the three side effects of `sync-sessions`:
1. Device registration (the `DEV#` row) → when the Bridge connects.
2. The threads-changed push → B3.
3. `lastKnownStatus` is set only after the POST succeeds at most call sites, and the session index
   trusts it first → set it directly.

Also: `checkStopped` takes its candidates from the local index, not `GET /active-sessions`.

Then delete:
- **Bridge:** `sync.mjs` uploads, `uploadMessages` and the startup message sync,
  `realtime-delivery.mjs`, `session-ack-queue.mjs`, `wsSendWithAck` and the HTTP fallback, `noCache`,
  `handleSyncSession`, `bridge_recovery_complete`, the rename mirror. The `synced` map stays only as
  the watcher's read cursor.
- **Server:** `/sync-sessions`, `/sync-messages`, `/session-title`, `/delete`, `/active-sessions`,
  `/session-threads`, `/messages`, the message write and relay branches in `bridge_ws.py`,
  `message_history.py`, the stream trigger of the notification worker.
- **Infra:** the `BridgeMessages` table; `SESS#` / `PROJ#` rows, both indexes and the stream on
  `BridgeSessions`; the Subscriptions table if B4 no longer needs it.
- **App:** the v1 socket code in `ws.js` (connect, probes, pings, send queue, `sync_complete`),
  dead `file_ready` / `file_progress` branches.

Stays: Connections table, `DEV#` rows, tokens, push devices, the notification event feed.

## Known gaps to fix on the way

- **`agentDetail`:** home cards and the Session list still render it, but the v2 index fills it
  only for daemon agents; a permission prompt in a Baton-driven turn reaches DynamoDB only. Read
  the Bridge's pending prompt in the index (needed by B4 too). Found by reading code, not yet
  reproduced on screen.
- **Credential expiry:** see B1. Not reproduced (needs a visible page idle for over an hour).

## Later (not in this step)

Persistent outbox; prefetch; attachment lifecycle and encryption; FCM for Android; terminal and
preview pairing off Lambda (with the EC2 relay); the stale-chunk fix for `main` is PR #191.

## Workflow

Proposal first, code after confirmation; minimal changes; reproduce before fixing; sub-PRs
`v2/<feature>` into `feat/v2`; verify on `BatonV2` in the browser (and on Device Farm when it
matters); merge only when asked.
