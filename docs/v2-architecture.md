# Baton v2.0 Architecture: Hosted Service, No Server-Side Conversation Storage, End-to-End Encryption

Status: **design proposal, not implemented**. Written 2026-11-03. Nothing in this document is deployed;
cost figures are estimates unless marked *measured*.

## 1. Goals

1. People without an AWS account can use Baton without registering: run one install command on the
   computer, open the App and scan the QR code the computer shows.
2. Conversation data never leaves the user's own devices except in transit through our relay, and the
   relay only sees ciphertext.
3. A public hosted service stays cheap enough to run free for early users (budget: about ¥1000/month).
4. Self-hosting keeps working, and existing TestFlight users are not broken by the upgrade.
5. Session viewing, streaming, permissions, Git, files and terminal keep their current pages and behaviour.

Non-goals for v2.0: hosted cloud machines with Claude Code / Codex preinstalled, Android store release
(open question in section 13), mainland China App Store (requires App ICP filing), billing/IAP (but the
hooks in section 17 are in scope).

Release plan: 1.1.0 is feature-stable and only receives 1.1.x fixes; no new work goes into the v1 data
layer (DDB, REST lists). The UX gaps found in section 16 are scheduled inside 2.0 (section 16.2).

## 2. Decisions

| Topic | Decision |
|---|---|
| Conversation storage | **Not stored server-side.** Bridge's local JSONL is the only source; the phone caches what it has shown. No DDB message table, no S3 copies of lists or history. |
| Sync path | App ⇄ relay ⇄ Bridge over WebSocket only. All history, lists and status are requested from Bridge on demand. |
| Encryption | App ⇄ Bridge end-to-end encryption of every content payload. The relay routes on clear metadata only. |
| Deployment profiles | **A. Self-host:** CloudFront + API Gateway WebSocket + Lambda (current stack, minus conversation storage). **B. Hosted:** CloudFront + one EC2 instance in Tokyo running a resident relay. |
| Accounts (hosted) | No registration. The first Bridge creates the account from the account key; devices join by QR code; no email is stored. Self-host keeps API-key mode. |
| Server-side state | Account / token / push-device rows; connection routing (DDB in profile A, process memory in profile B); attachments in S3 encrypted with a 7-day lifecycle; logs kept at most 7 days. |
| Client protocol | Identical for both profiles. Only the frame size limit differs, announced by the server. |
| Repository and license | One public repository under MIT, including the hosted relay source; secrets and production parameters stay outside it (section 15). |

### Relation to the 2026-09-16 decision

`docs/terminal-relay-options.md` records that a resident EC2/Fargate relay was ruled out on 2026-09-16.
That decision assumed every user deploys their own stack; there, API Gateway direct forwarding is cheap
and fast enough, and it remains the self-host profile here. Profile B exists only for the shared hosted
service, where per-message API Gateway pricing grows with the user count (section 11). The earlier benchmark
still applies: a same-region standalone WSS relay measured p50 1.64/1.87 ms versus 144–147 ms for the old
Gateway + Lambda path (`docs/terminal-resident-relay-benchmark.md`).

## 3. Architecture

```text
                       ┌──────────────── CloudFront (api.agentbaton.app) ────────────────┐
 App (iOS/Web/Desktop) │  default → REST        /ws → control WS       /data → data WS   │  Bridge (user machine)
        ▲              └───────────────┬───────────────────────────────────┬──────────────┘        ▲
        │                              │                                   │                       │
        │          Profile A (self-host)                         Profile B (hosted)                │
        │   REST API GW + Lambda (auth, small RPC)        EC2 t4g (Tokyo): Node relay              │
        │   WsApi + Lambda (control: connect, open,       - auth, per-account routing in memory    │
        │     subscribe, request routing)                 - forwards frames, no storage            │
        │   TerminalDirectApi (data sockets)              - REST: auth, account, attachments       │
        │   rpc / push routes: HTTP integration →         DDB: accounts / tokens / push devices    │
        │     @connections, no Lambda per frame           S3: encrypted attachments (7-day TTL)    │
        │   DDB: connections, subscriptions, tokens                                                │
        └──────────── ciphertext only ─────────────────────────────────────────────────────────────┘
```

Clients only ever know `https://api.agentbaton.app` (or the self-host CloudFront domain). Moving the hosted
service between profiles A and B, or between machines, is a CloudFront origin change with no App or Bridge
release.

### 3.1 Profile A: CloudFront + API Gateway + Lambda (self-host default)

- The existing distribution (`server/template/Baton.template`, `AWS::CloudFront::Distribution`) has one
  origin, the REST API (`/v1`), with the managed CachingDisabled and AllViewerExceptHostHeader policies.
  Add two behaviours: `/ws` → `WsApi`, `/data` → `TerminalDirectApi`. AllViewerExceptHostHeader already
  forwards the query string (`?apiKey=`) and `Sec-WebSocket-*` headers and keeps API Gateway's own Host.
- Real-time frames keep the direct path: Bridge → `push` route on the data API → HTTP integration →
  `@connections/{id}` → App data socket. No Lambda runs per frame
  (`docs/v2-step3b-realtime-plan.md`). The integration calls `execute-api` internally, so CloudFront
  does not affect it.
- Multi-tenant: direct-forwarding credentials cannot be scoped to single connections (section 12,
  item 8), so profile A as built is single-tenant; account isolation needs another mechanism there.
- New Bridge → App bulk responses (history pages, lists) use the same direct path. Only the App's small
  request ("page N of session S") goes through `ws-handler`, because the App holds no signing credentials
  and Lambda must authorise it and resolve the target Bridge.
- Frames stay within API Gateway limits: 32 KB per frame (metered per 32 KB), 128 KB per message. Data
  frames, not WebSocket ping/pong control frames, are billed.
- `ws-handler` runs with 128 MB today. Raise it (512 MB–1 GB) to cut the request hop and cold starts.
- DDB keeps only connection/subscription rows, device rows and auth rows. `BridgeSessions` /
  `BridgeMessages` are deleted.

### 3.2 Profile B: CloudFront + EC2 (hosted)

- One Graviton instance in `ap-northeast-1`, started at `t4g.micro` (1 GB). `t4g.nano` is not used: after
  the OS, Node, TLS terminator and connection buffers there is little headroom, an OOM disconnects every
  user, and its CPU baseline is the lowest of the family.
- One Node process: authenticates connections, keeps `accountId → {bridges, apps, subscriptions}` in
  memory, forwards frames. Routing state is rebuilt by client reconnects, so it is never persisted
  (about 0.2–0.5 KB per connection; the sockets themselves dominate memory).
- TLS origin certificate via Caddy or similar; systemd restart; EC2 auto-recovery; image-based redeploy.
  The disk only holds the OS, program and rotated logs (8 GB gp3).
- CloudFront WebSocket idle timeout is 10 minutes of no origin → client bytes, so the relay sends a ping
  on every connection at least every 5 minutes.
- permessage-deflate can be enabled here (it is disabled under API Gateway). Follow the CloudFront
  guidance to forward `Sec-WebSocket-Extensions` and related headers, and verify it end to end.
- Frame limit: no CloudFront WebSocket frame quota is documented; announce a conservative
  `maxFrameBytes` (e.g. 512 KB–1 MB) and verify before relying on it.
- Graceful restart: tell clients to reconnect within a random 0–10 s window, then stop. Today Bridge
  reconnects immediately after the first failure and then every fixed 5 s (`bridge/ws.mjs:848`), and the
  App every fixed 3 s (`web/js/ws.js:457`); both need jitter before profile B goes live.
- Scaling: vertical first (`t4g.micro` → `t4g.small/medium` → `c7g.large`). One process is expected to be
  enough to about 10k active users; beyond that, shard by `accountId`.

## 4. Data placement

| Data | Location | Server-side retention |
|---|---|---|
| Messages, tool details, Session/Project lists, status | Bridge machine (JSONL + Bridge index) | none |
| Viewed sessions and lists | Phone (IndexedDB / existing localStorage list cache) | none |
| Account: `accountId`, join-secret hash, device list, token hashes, push devices (no email) | DDB (both profiles) | while the account exists |
| Pairing codes, start/install tokens | DDB with TTL | 10 minutes |
| Connections / subscriptions | Profile A: DDB; profile B: process memory | while connected |
| Session metadata Baton owns: archived, deleted/hidden, pinned | Bridge (`~/.baton-bridge/session-meta.json`; Codex archive uses the native thread state) | none |
| Attachments (images sent from the phone, previews, videos) | S3, encrypted, behind CloudFront | 7-day lifecycle; after that the App loads the file Bridge saved locally when it received it |
| Command catalogs | Requested from Bridge (today stored in S3) | none |
| Logs | CloudWatch / local files: errors, start/stop, security events, per-minute aggregates; never content, paths, titles, tokens or request bodies | 7 days maximum |

Accepted trade-off: when a computer is asleep or offline, the phone shows only what it has cached and marks
the device offline. Sessions never opened on that phone are unavailable until the computer is back. An
opt-in encrypted "offline access" cache can be reconsidered later if users ask for it; it is out of v2.0.

## 5. Relay protocol

The protocol is transport-agnostic so profile A's Lambda handler and profile B's relay share one core.

- **Envelope** (clear, used for routing and ordering): `action`, `device`, `sessionId`, `requestId`,
  `turnId`, `seq`, `chunk {index, count}`, `keyId`. Everything else is in `payload`, which is ciphertext.
- **Capabilities:** `/devices` returns `protocol: 2` (API Gateway cannot answer on `$connect`). Chunk sizes
  are fixed by the sender. The v2 App does not support older servers; it asks the user to update the
  stack (decided 2026-11-06, replacing the v1 fallback in section 10).
- **Request/response to Bridge:** `history_page {sessionId, before|after, limit}`, `list_projects`,
  `list_sessions`, `active_sessions`, `session_status`, plus the existing `tool_details`, file, Git and
  command RPCs. Bridge answers to the requesting connection only.
- **Session sequence:** every Session gets `epoch + seq`, assigned by Bridge across turns (`epoch` changes
  when Bridge restarts or rebuilds its index). `history_page` pages `after` a seq until no newer rows; an
  unknown epoch or a cursor that no longer exists returns a fresh snapshot instead of a partial replay. The
  IndexedDB cache fills incrementally from this cursor, and most of `replaceHistoryTail`'s special cases go
  away. The turn-local stream (`LiveTurnStream`, `TurnEventQueue`, `StreamCoordinator`) stays, nested inside
  it; payloads are encrypted.
- **Send idempotency:** Bridge keeps recently seen `turnId`s and ignores a repeated `send_message`, because
  App and Bridge both resend queued frames after a relay restart.
- **Session metadata:** archive, delete/hide and pin are Bridge requests; Bridge stores them (section 4),
  filters lists, and broadcasts each change to the account's Apps. Codex archive calls the native
  `thread/archive` / `thread/unarchive` and follows `thread/archived` / `thread/unarchived`; Claude only uses
  Bridge's record and never moves JSONL. Archived Sessions are read-only until restored; running or
  `needs_input` Sessions cannot be archived. PR #3 (Codex archive, stored in DDB) supplies the native
  archive module, safety checks and UI, but not its server storage.
- **Runtimes:** `runtime` is an open string and Bridge reports each runtime's capabilities, so agents added
  later (ACP) need no protocol change.
- **Oversized authoritative messages:** pushes and replies are split into direct-channel chunks
  (`bridge/direct-rpc-protocol.mjs`), so nothing is truncated; full tool content still comes from
  `tool_details` on demand. Bulk data must not block the stream (keep the control and data sockets separate).
- **Paging on Bridge:** a per-file `line → byte offset` index so pages are read backwards from the tail
  without parsing the whole JSONL. Lists are sorted and paged on Bridge. Page sizes stay as they are today.
- **Compress, then encrypt:** payloads are compressed before encryption (Node `zlib`, browser
  `CompressionStream`), because ciphertext does not compress. JSON usually shrinks 4–10×, so a history page
  needs far fewer 32 KB frames in profile A, which also lowers the per-32 KB message charge. This is
  application-level compression of the payload, not the WebSocket permessage-deflate extension that stays
  disabled under API Gateway.
- **Frame budget:** chunk sizes already reserve the encryption overhead (section 6, about one third), so
  turning encryption on later does not change chunking.
- **Chunk reassembly:** Bridge sends all chunks of a response back to back without waiting. In profile A
  each frame is a separate HTTP integration call and may arrive out of order, so the receiver reassembles
  by `chunk.index`.

## 6. End-to-end encryption

The model is the one used by password managers and iCloud Advanced Data Protection for one person's own
devices: one symmetric account key shared by all of that user's devices. Per-message ratchets (Signal
protocol) target multi-party chat and are not needed here.

- **Key:** one random 256-bit account key per account, created on the first device and stored in the
  Keychain / Keystore / Bridge `config.json` (0600). Each payload carries a `keyId`.
- **Algorithm:** AES-256-GCM with a random 12-byte nonce per message, using only platform APIs (WebCrypto,
  iOS CryptoKit, Node `crypto`); no third-party crypto library. A random nonce is safe for about 2³² messages
  per key; the heavy user in section 11.1 sends about 3M frames a month, so this limit is not reached in
  practice, and the key is replaced whenever a device is removed.
- **Associated data:** `sessionId`, `turnId`, `seq` and `action` are passed as AES-GCM additional
  authenticated data, so the relay cannot move a ciphertext to another Session or position without
  decryption failing.
- **Key distribution:** described with the pairing flows in section 7. The key travels only inside a QR code
  scanned locally, or encrypted to a public key that was itself read from a QR code, so the relay can never
  substitute a key of its own.
- **Recovery:** the key itself, encoded as 24 words, is the recovery phrase.
- **Device removal:** revoke the device's token first, then generate a new key (`keyId` + 1) and send it to
  the remaining devices encrypted under the old key; the relay no longer delivers anything to the revoked
  token. Nothing is stored server-side, so no history has to be re-encrypted.
- **Key loss:** history is not lost. Bridge holds the plaintext; create a new key and pair again.
- **Clear metadata:** routing envelope fields, timestamps, sizes, connection times. The privacy policy states
  this.
- **Notifications:** Bridge encrypts the title and body; the ciphertext goes in the APNs payload (4 KB
  limit). The iOS Notification Service Extension decrypts with the key from the shared Keychain group. The
  server no longer stores notification text (today: `NOTIFICATIONS#<account>` rows with plain text for 7 days).
- **Attachments:** encrypted before upload. Content-hash deduplication is computed per account on
  ciphertext or replaced by a per-account keyed hash; design detail deferred.
- **Overhead:** base64 + GCM tag adds about one third, so frame-size budgets must account for it.
- **Not protected:** metadata (who connects when, sizes, `sessionId`), frames the relay drops or delays
  (detected through `seq` gaps, not prevented), and compromised user devices.

## 7. Accounts and authentication

The hosted service has no registration step, following Happy (the key is the account) and the local
pairing of t3code / Orca (scan a QR code shown by the computer). Section 16 compares the competitors.

- **Account identity:** the first Bridge creates the 256-bit account key (section 6). Two values are derived
  from it with HKDF: `accountId` and a join secret. Bridge registers `{accountId, hash(joinSecret)}`; the
  server never sees the key and cannot derive it. No email, password or third-party sign-in exists, so Sign
  in with Apple is not required.
- **Tokens:** one token per App install and per Bridge, stored as a hash (`hash(token) → accountId,
  device`), individually revocable. This builds on the device-credentials work on the
  `feat/device-credentials` branch (not on `main` at the time of writing).
- **First run:**
  1. The install command starts Bridge, which creates the key, registers the account and receives its token.
  2. Bridge prints a QR code with the server URL, a single-use pairing code (10 minutes) and the key, plus the
     same content as a copyable pairing link for an App on the same computer or without a camera.
  3. The App opens on "Scan the QR code on your computer" (secondary entry: "Use my own server"). Scanning
     stores the key in the Keychain / Keystore, exchanges the pairing code for an App token and opens the
     home page. Bridge clears the QR code once it has been used.
- **Another computer:** its Bridge has no key, so it prints a QR code with a pairing code and a fresh P-256
  public key. A signed-in phone scans it, the user confirms "Add computer *name*?", and the phone sends the
  key encrypted to that public key (ECDH + HKDF + AES-GCM, WebCrypto). The relay cannot substitute the public
  key because it came from the scanned QR code. No key passes through the clipboard or shell history.
- **Another phone or tablet:** a signed-in device shows a QR code with a pairing code and the key.
- **Recovery:** with no signed-in device left, entering the 24-word phrase recreates the key, `accountId` and
  join secret, and the server issues a new App token. Showing the phrase in Settings is optional. If the key
  is lost entirely, history is still in the computers' JSONL: re-run pairing to create a new account.
- **Device management:** Settings lists every computer and phone with its last connection time; each can be
  revoked, followed by key rotation (section 6).
- **Abuse limits:** the server cannot tell a Bridge from a script, so accounts are limited by creation rate
  per IP, a cap on computers per account (3 on the free plan, as T3 Connect does), per-device request rates,
  and removal of accounts that never pair a phone within 24 hours.
- **Email:** not in v2.0. It may return later as an optional recovery or notice address, never as a sign-in
  requirement.
- **Self-host:** keeps API-key mode.
- **App Store requirements:** in-app account deletion (removes the account row, tokens and push devices and
  tells every Bridge to forget its credentials and key); a review pairing link that connects to a demo Bridge
  with seeded Sessions; a privacy policy URL. Use the store name AgentBaton if Baton is taken; do not use
  third-party trademarks in the name.

## 8. Push notifications

- Trigger moves from the `BridgeSessions` stream to Bridge: on `completed` / `needs_input`, Bridge sends an
  encrypted `notify` event to the relay. "Being viewed" suppression is checked at the relay, which knows the
  live subscriptions.
- Events produced while Bridge is disconnected are queued on Bridge and sent after reconnect (new work).
- Push devices are stored per account (`PUSH_DEVICE#<accountId>`). Today every event queries one shared
  `PUSH_DEVICE` partition holding every account's devices (`notification_worker.py`).
- Android's 5 s / 15 s polling must move to push or a socket before an Android store release: at 15 s it is
  about 170k requests per device per month.

## 9. Client changes

Pages and interactions stay as they are: home, lists, Session view, streaming, permissions, Git, files,
terminal. Changes are in the data layer plus a few required screens.

- **Data layer:** call sites keep their current shape: `api('/api/bridge/projects', params)` and the other
  list/history calls, the same JSON responses and the same cursor semantics. Only `api.js` changes: when the
  server reports `protocol: 2`, these calls are sent to Bridge as WS requests with a `requestId` and resolve
  with the matching reply; otherwise they use REST as today. Pages, list caches and rendering are untouched,
  and compatibility with old servers lives in this one place.
- **Why not REST to Bridge:** the server no longer holds the data, so REST would have to forward to Bridge
  and wait. That is simple in profile B (one process holds both sockets) but not in profile A: Bridge's reply
  arrives in a different Lambda invocation (`ws-handler`), so the REST Lambda would have to poll a shared
  store until it appears, within the 29 s REST timeout.
- **Session cache:** add IndexedDB history per device/session (today only lists, Git, project files,
  attachments and drafts are cached). Show cached history first, then fetch only newer rows; cap the size
  (200–500 MB) and evict least-recently opened.
- **Outbox:** queued user actions (`send_message`, `interrupt`, permission replies) are kept in IndexedDB,
  not only in memory, so an App killed by the OS or a relay restart does not lose them; `turnId` makes the
  resend safe.
- **Prefetch:** after the home or list loads, fetch the first page of active and recent Sessions in the
  background so that most first opens hit the cache.
- **Home across devices:** request each online Bridge, merge, and render as each one answers; offline
  devices show cache with an offline label.
- **New screens:** QR scan / pairing link as the first screen with "Use my own server" as the alternative;
  "Add computer" confirmation; device list with revoke; recovery phrase entry and display; account
  deletion; device offline indicator.

## 10. Compatibility and migration

| Combination | Behaviour |
|---|---|
| New App + old self-host stack | Server reports no `protocol: 2` → App shows "Server update required". |
| New App + upgraded self-host stack | v2 path. Bridge auto-updates from the same stack. |
| Existing TestFlight user | Stored `_as` / `_ak` keep working against their own stack. |
| Moving to hosted | Re-run the install command and scan the QR code it prints; history is read from local JSONL, nothing to migrate. One Bridge connects to one server. |

- Superseded: there is no read-only `BridgeMessages` fallback or v1 App path; step 3 deleted both tables.
- Profile A → B for the hosted service: deploy the relay, verify, switch the CloudFront origin, then close
  the old connections so every client reconnects to the new origin at once. Running turns survive because
  Bridge queues frames while disconnected (`wsSendWhenConnected`), the App queues user actions
  (`wsSendReliable`) and resumes turns from the next checkpoint, and pending permissions are re-sent on
  re-subscribe.

## 11. Cost model

### 11.1 Measured, October 2026 (one heavy user, Baton stack, `ap-northeast-1`)

| Item | Usage | Cost |
|---|---|---|
| API Gateway WebSocket | `Baton-ws` 1.03M messages, `Baton-terminal-data` 2.05M messages | $5.29 |
| DynamoDB | 3.82M WRU ($2.73), 2.80M RRU ($0.40); `BridgeMessages` 524k items / 373 MB | ~$3.5 |
| Lambda | `ws-handler` 259k invocations, `APIHandler` 225k | ~$0.5 |
| S3 attachments | 7.15 GB, 1677 objects, no lifecycle rule | ~$0.2 |

`Baton-terminal-data` is the shared data API: real-time chat delivery to App data sockets, terminal and
preview tunnels. Per-route detailed metrics are disabled, so the split is unknown.

### 11.2 Estimates

Assumptions (not measured): a typical active user is one fifth of the heavy user above, about
0.5 GB/month of relay egress, the same ingress, 1 GB/month of attachment downloads, and about 2000
requests/month (reconnects, attachment downloads).

| Active users | Profile A (API Gateway, no DDB) | Profile B (EC2 + CloudFront) |
|---|---|---|
| 100 | ~$60–70 | ~$13–26 (t4g.micro, CloudFront Free plan or pay-as-you-go) |
| 1,000 | ~$600–700 | ~$45–60 (Pro plan $15) |
| 10,000 | ~$6,000+ | ~$105–125 (c7g.large on demand, Pro); ~$40 with a reserved t4g.medium if load permits; ~$300 if the request count forces the Business plan |

Break-even between the two profiles is about 20 active users (≈$12/month); in practice switch the hosted
service to profile B by the time its monthly bill exceeds about $30.

### 11.3 Pricing facts used (official pages, checked 2026-11-03)

- API Gateway WebSocket: metered per 32 KB, 128 KB maximum message; ping/pong control frames free. Free
  tier (1M messages + 750k connection minutes) only for new customers' first 12 months; accounts created
  from 2025-07-15 get up to $200 credits instead.
- CloudFront pay-as-you-go: always free 1 TB out + 10M requests per month. Japan out $0.114/GB after that.
  "There is no additional charge for sending data over WebSocket"; client → origin WebSocket traffic is
  billed as Regional Data Transfer Out to Origin, Japan $0.060/GB, not in the free tier. Origin fetches
  from AWS origins (EC2 included) are free.
- CloudFront flat-rate plans, per distribution, monthly, no overage charges ("Usage allowances are not hard
  limits"): Free $0 (1M requests, 100 GB), Pro $15 (10M, 50 TB), Business $200 (125M, 50 TB). "Data
  transfer between CloudFront and your AWS origins is automatically waived." At most 3 Free plans per
  account; a Web ACL must be attached; not combinable with other offers.
- CloudFront WebSocket quota: idle timeout 10 minutes without origin → client bytes; WebSocket over
  HTTP/1.1 only.
- EC2 Tokyo on demand: t4g.nano $0.0054/h, t4g.micro $0.0108/h, t4g.small $0.0216/h; public IPv4
  $0.005/h.

## 12. Existing issues to fix for multi-tenancy

These are acceptable for a single-tenant self-host stack but must be fixed before the hosted service:

1. `BridgeMessages` is keyed by `sessionId` only; `get_messages` (`server/src/bridge_read.py`) and WS
   subscribe (`server/src/bridge_ws.py`) do not check the account. Retired by the v2 design, but every REST
   and WS entry point (tool details, files, terminal, device routing) must be audited for account scoping.
2. A single deployment API key maps to one account (`server/src/api_key.py`); hosted needs the per-token
   table (section 7).
3. One shared `PUSH_DEVICE` partition (section 8).
4. Plain-text notification events stored for 7 days (section 6).
5. Lambda log groups have no retention (`Baton-ws-handler` 257 MB, `Baton-APIHandler` 168 MB stored);
   set 7 days and confirm no content is logged.
6. The attachment bucket has no lifecycle rule; it has S3 Transfer Acceleration enabled, which adds a
   per-GB upload charge.
7. Hosted production should run in a dedicated AWS account, separate from the current shared account.
8. **Required:** the direct-forwarding STS credentials Bridge receives allow
   `execute-api:ManageConnections` on `…/POST/@connections/*` of the data API (`callback_policy` in
   `server/src/direct_rpc_ws.py`), i.e. any connection on that API, not only the same account's.
   E2EE would stop content injection but not bandwidth abuse, so this cannot support untrusted
   multi-tenancy. Measured 2026-11-06: per-connection session policies
   (`…/POST/@connections/<connectionId>`) always deny, because API Gateway authorizes against the route
   template `…/POST/@connections/{connectionId}`. Credentials therefore cannot be narrowed below the whole
   data API, and since phase 1 step 1 the App receives the same scope (`docs/v2-step1-home-plan.md`).
   Multi-tenant options: receivers verify per-account frame signatures, the hosted service uses only the
   EC2 relay, or untrusted senders go through Lambda forwarding.

## 13. Open questions and validation before implementation

1. Measure real per-user relay traffic and frame counts by type (chat stream / terminal / preview) on Bridge
   for one week; recompute section 11.
2. CloudFront: how a WebSocket upgrade counts toward requests; whether a large frame (≥1 MB) passes;
   whether deflate works end to end; idle-timeout behaviour with the planned ping interval.
3. Profile B load test: idle connections per GB of memory; sustained frames per second on `t4g.micro`
   (CPU credits).
4. First-open latency in profile A (Lambda request hop + Bridge read + chunked response) with and without
   prefetch.
5. Reachability from mainland China mobile networks (no CloudFront edge in the mainland).
6. Attachment encryption vs content-hash deduplication.
7. ~~Connection ARNs in an STS session policy~~: moot, per-connection scoping does not work (section 12,
   item 8).
8. Android on the hosted service: today it polls a server-side event feed every 5 s / 15 s, which v2 removes
   and which would cost about 170k requests per device per month. Decide between FCM push or a socket for
   hosted Android, or Android notifications off on hosted, before Android users can pair with it.
9. Item 5 (mainland China reachability) is tested during phase 1, not before the store release, because it
   decides whether the hosted service can serve those users at all.

## 14. Suggested phases

The riskiest assumption is that the experience survives without DDB, so it is validated first; accounts and
encryption build on the data flow it settles.

1. **Core: no DDB, everything over WS (profile A, our own stack).** Bridge paging/index and list RPCs,
   session `epoch + seq`, send idempotency, Bridge-owned Session metadata (archive), attachment fallback,
   App IndexedDB cache, prefetch and persistent outbox, capability negotiation with v1 fallback, CloudFront
   `/ws` and `/data` behaviours. Validation targets, against v1 as the baseline:
   scan or open to Session list ≤ 3 s; first open of a Session with and without cache; home load across
   devices; foreground resume; message completeness on a weak network; Bridge CPU and memory with the
   index. Also measure section 13 items 1, 4 and 5 here.
2. **Multi-tenant, accounts and pairing:** account key creation, key-derived accounts with QR pairing,
   device list and revoke, account deletion, access audit and fixes (section 12, including per-connection
   direct-forwarding credentials), log retention, attachment lifecycle, reconnect jitter, abuse limits.
   One cross-account isolation test suite runs against both profiles.
3. **End-to-end encryption:** payload encryption, key rotation on device removal, encrypted push payloads.
4. **Profile B:** resident relay sharing the protocol core, CloudFront origin switch for the hosted
   service, monitoring and alarms.
5. **Store release (iOS)** on the hosted service, self-host still selectable; `PRIVACY.md`,
   `SECURITY.md`, the README changes in section 15 and the launch items in section 17 ship with it.
6. **After the store release:** the remaining UX gaps in section 16.2.

## 15. Repository and license strategy

### 15.1 What comparable projects do (checked 2026-11-03)

| Project | License | Repository | Relay source | Private part | Revenue seen |
|---|---|---|---|---|---|
| Happy (`slopus/happy`, ~24k stars) | MIT | One monorepo: iOS/Android/web App, CLI, relay server, self-host server, push server | Public | none found | none shown ("Free and open source") |
| Paseo (`getpaseo/paseo`, ~23k stars) | Apache-2.0 | One monorepo: Apps, daemon, relay transport and encryption, website/docs; separate public distributed relay (`getpaseo/paseo-relay`) | Public | none found | GitHub Sponsors and company sponsorships |
| Orca (`stablyai/orca`, ~114k stars) | MIT | One monorepo: desktop, mobile, `cloud/` (relay, wire contract, push gateway, connector) | Public | Deployment and operations only, in a private `orca-cloud` repository | none shown |

All three keep one public repository under a permissive license, publish the relay, use end-to-end
encryption, and compete on product, distribution and trust rather than on secret code.

### 15.2 Decision

- **Keep MIT. Everything is in this public repository:** App, Bridge, profile A (API Gateway + Lambda,
  `install.sh`), profile B relay source, protocol core, protocol and cross-account isolation tests.
- **Secrets never enter the repository:** API keys, APNs keys, signing certificates, AWS account IDs and
  certificates stay in `.env.local` (git-ignored), Secrets Manager, SSM or GitHub Secrets; the repository
  only has templates such as `.env.local.example`.
- **Production parameters** (instance size, rate-limit thresholds, alarm addresses) are read from SSM /
  GitHub Secrets by public deploy scripts. A small private operations repository, as Orca does, is only
  added if that configuration grows.
- **Trademark notice in the README:** the code is MIT, but the Baton / AgentBaton names and logos are not
  licensed; forks must publish under another name and must not present themselves as the official service.
- **Relicensing stays possible:** if a competing hosted service appears, future versions can move to a
  source-available license such as FSL. Released MIT versions cannot be withdrawn; MIT contributions can be
  included in a more restrictive future version.
- **Accepted consequence:** anyone may legally run a competing hosted service from this code. Our advantages
  are the store presence, the brand, the hosted service working out of the box, verifiable privacy and the
  pace of product work.

### 15.3 Repository as the entry point

- **`PRIVACY.md`:** what the server stores (account rows, encrypted attachments for 7 days, logs for at most
  7 days) and what it does not (conversations, lists, notification text), plus the metadata that stays in
  clear. The App Store privacy policy links to it.
- **`SECURITY.md`:** how to report vulnerabilities and a short description of the encryption design
  (section 6).
- **README:** links to agentbaton.app, the App Store and the docs at the top; the first screen states that no
  AWS account is needed, that conversations are end-to-end encrypted and not stored server-side, and that
  self-hosting remains available.

## 16. Competitor analysis and suggestions (2026-11-03)

Source read: t3code, Paseo, Orca, litter, Happy (HEAD of 2026-11-03).

- **No server-side storage is the norm.** t3code, Paseo, Orca and litter keep no conversation data on the
  server; Happy stores ciphertext (Postgres + Redis) and still leaks push titles, usage data and KV keys in
  clear. All of them show nothing for an offline computer beyond the client cache, which confirms the
  section 4 trade-off.
- **Our lasting advantage:** none of them passively mirrors terminal / VS Code / daemon-agent Sessions; each
  only sees Sessions it launched or imported once. Keep this in v2.
- **Local port preview is a second lead, not unique.** Baton tunnels real HTTP from the phone's webview to
  the computer's `localhost:<port>` over the relay, with no SSH, on every platform. t3code and Orca stream
  pixels instead (t3code: headless Chrome on the host plus port discovery; Orca: CDP screencast of the
  desktop's built-in browser, so the desktop app must be open). Happy's new native iOS client (iOS 26,
  UIKit port) routes WKWebView through the computer like Baton; Paseo and litter have none. v2 must carry
  preview frames inside the E2EE payload: today they are only SigV4-signed stream frames, not encrypted.
- **Onboarding gap:** every competitor is "install one thing, scan one QR" with no cloud account. v2's
  hosted profile closes this; prefer a reverse flow (Bridge prints a QR or device code, the phone approves)
  as Happy and t3code do.
- **Accounts are optional everywhere.** Happy has none (a generated key is the account); litter has none
  (optional ChatGPT sign-in); Paseo's App has none (the QR code is the credential; only its Hub has
  accounts); t3code (Clerk) and Orca (`login.onorca.dev`, desktop-only sign-in) ask for an account only when
  the user picks their hosted relay. None asks during onboarding. Section 7 follows this.
- **Sync model to adopt in protocol v2:** Session-level `epoch + seq`; `history_page` pages `after` a seq
  until no newer rows; on epoch mismatch or a cursor that no longer exists, reply with a fresh snapshot
  instead of partial replay (Paseo, t3code, Orca, Happy all converge on this). It is also the cursor the
  IndexedDB cache needs for incremental fill, and removes most of `replaceHistoryTail`'s special cases.
- **Send idempotency:** dedupe user sends on Bridge by `turnId` (Paseo message receipts, Happy `localId`).
- **Later, not v2.0:** LAN / Tailscale direct path to Bridge (t3code, Paseo, Orca); cumulative-snapshot
  stream frames so a lost frame self-heals (t3code, Orca).
- **Additional accepted trade-off:** Claude Code deletes transcripts after `cleanupPeriodDays` (default 30),
  so without `BridgeMessages` older history exists only in a phone cache. Mention it in Settings.
- **UX features seen elsewhere, outside this design:** allow-for-session / abort in permission prompts,
  Allow/Deny actions on notifications, diff line comments sent to the agent, editing queued messages,
  rewind to a message. (Voice input is covered by system dictation; Live Activity, Watch and widgets are
  judged unimportant.)

### 16.1 Strengths and gaps

| Baton strength | Competitors |
|---|---|
| Mirrors every existing Session (terminal, VS Code, daemon agents, Codex) | All five see only Sessions they launched or imported once |
| Transcript fidelity: full tool IN/OUT on demand, never hard-truncated | t3code keeps a 64 KB output tail, Paseo ~64K, litter 128 KB; Orca desktop loads full output; Happy shows full output on a separate page |
| Inline interactive HTML from any agent output, visible while streaming | t3code / Orca / litter only via a dedicated tool or directive (only litter streams); Paseo only in the file panel; Happy none |
| Mermaid rendered while streaming, downloadable | Paseo streams a prefix; t3code waits for the closed fence (web only); Orca waits for the end; litter none; no one exports |
| LaTeX, inline images, Markdown documents | t3code and litter comparable; Orca desktop partial, mobile no math; Paseo and Happy no math |
| Local port preview: real HTTP, no SSH, all platforms | t3code / Orca stream pixels (Orca needs the desktop open); Happy's new iOS 26 client only; Paseo / litter none |
| Reliable push with presence check; headless CLI that never interrupts the terminal | t3code / Orca push needs their account; litter polls; Happy kills the terminal process |
| File previews (Office, video, PDF) and Git graph / commit / push | t3code mobile previews PDF and video; others mostly diff and file panels; no Office preview found |

Parity, not a lead: tool-call grouping ("Ran 3 commands") exists in t3code, Paseo, Orca and litter; pending
permission prompts survive reconnects in t3code, Paseo, Orca and Happy (litter only in memory); sending
more messages while a turn runs works in Baton through the CLIs' own queueing (Claude stream-json stdin,
Codex per-Session queue), as in t3code, Paseo and litter; multi-question AskUserQuestion answered step by
step exists in t3code (progress + active question), Paseo (one tab per question) and Orca (Next / Step N),
while Happy lists all questions inline.

| Baton gap | Competitors | Covered by v2 |
|---|---|---|
| Only Claude Code and Codex | t3code 8+ providers, Paseo ACP (Cursor, Kimi, Copilot…), Orca 30+, Happy Gemini / ACP, litter Claude / Pi / OpenCode | No: needs a Bridge runtime adapter interface plus ACP |
| AWS deployment before first use | Install one thing, scan one QR | Yes (hosted profile, reverse pairing) |
| No end-to-end encryption | Happy, Paseo, Orca, litter | Yes |
| Turn-scoped `seq`, complex recovery | Session `epoch + seq` with `after` paging | Yes |
| No parallel worktrees / multi-agent orchestration | Paseo, Orca, t3code | No |
| No rewind / checkpoints | t3code, Paseo | No |
| No diff line comments sent to the agent | t3code, Paseo, Orca | No |
| Permission prompts lack "allow for this Session" | litter (once / session / deny / abort), Happy (allow all edits…) | No |
| AskUserQuestion multi-select (`multiSelect: true`) is not supported | t3code, Paseo, Orca and Happy handle `multiSelect` | No |
| No Allow / Deny actions on notifications | litter | No |
| No LAN / Tailscale direct path | t3code, Paseo, Orca | Later |
| No scheduled tasks, event triggers or plugins | Paseo, t3code, Orca | No |

### 16.2 Gap schedule (decided 2026-11-05)

1.1.0 only receives fixes, so every gap is scheduled inside 2.0. Numbers follow the comparison page; within
a group, items are ordered by user impact.

| Group | Items |
|---|---|
| 2.0 core (phases 1–3) | No AWS deployment before first use (phase 2); end-to-end encryption (phase 3); session `epoch + seq`, archive with Bridge-owned state, persistent outbox, offline-cache trade-off (phase 1) |
| 2.0 other (phase 6, after the store release) | More agents (ACP); "allow for this Session"; AskUserQuestion multi-select; diff line comments sent to the agent; rewind; mobile terminal (scroll inside full-screen programs, pinch zoom, modifier lock, custom keys); Allow/Deny on notifications; PR flow; LAN / Tailscale direct path; parallel worktrees; scheduled tasks and plugins |
| Done | Linux DEB packages (1.1.0, PR #173) |

"Allow for this Session" and multi-select are small and may move before the store release.

## 17. Commercialization and launch readiness

2.0 is what makes Baton usable without AWS and listable in the App Store, so it carries the launch.

- **First value moment:** after scanning, the user immediately sees every existing Claude Code / Codex
  Session on the computer, which no competitor does (they start from an empty list). Target: scan to
  Session list ≤ 3 s, validated in phase 1 (Bridge list RPC speed plus prefetch right after pairing).
- **Billing hooks, no billing:** a plan field on the account (`free` / `pro`); per-account traffic counters
  and quotas at the relay, since terminal, port preview and large files dominate hosted cost; feature
  switches per plan. Competitor levers seen: machine count (t3code 3 / 10 / 100), hosted service tiers
  (Paseo Hub Free / Pro), paid voice (Happy).
- **Funnel metrics:** anonymous aggregate counts only, never content, paths or titles: Bridge installed →
  paired → first Session opened → first message sent → active on day 7. Whether it is on by default is an
  open decision (t3code: on by default).
- **Launch actions with the store release:** an in-app GitHub star prompt shown after a value moment
  (t3code and Orca star from the user's signed-in `gh` in one click); a Show HN that leads with mirroring
  existing terminal Sessions and the 5–8 MB app size; comparison pages on the website (Paseo has one per
  competitor); a 30-second demo video; a Discord; the README first screen states that no AWS account is
  needed.
