# v2 phase 4, PR 2: the hosted service on Cloudflare — design

Status: design, 2026-11-17, decided with the user; implementation starts after PR 1 (JavaScript server on AWS,
`server/core` + `server/aws`) is merged. Context: `docs/v2-relay-plan.md` (§3 measurements, §6 phases).
Goal: everything Baton does on AWS works on Cloudflare (pairing, chat, terminal, preview, files, notifications,
device management), at the lowest cost, with the same client protocol. Rules for every choice below: platform
best practice, then lowest cost, then least code.

## 1. Decisions (user, 2026-11-17)

| # | Decision |
|---|---|
| C1 | **Tokens carry the account ID**: new tokens are `bt_<accountId>_<random>`; the server still stores and checks only the hash. The Worker routes to the account's Durable Object without a lookup. AWS keeps resolving by hash, so existing tokens keep working there. |
| C2 | **A Cloudflare APNs relay** (`push-relay/worker.mjs`) next to the Lambda relay. AWS stacks keep calling the Lambda relay (IAM-authenticated Function URL); the hosted Cloudflare service calls the Worker relay through a **service binding** — internal only, no public route, the Cloudflare equivalent of the Lambda's IAM-only access. Verified 2026-11-17: a Worker's `fetch` reaches APNs over HTTP/2 (`api.push.apple.com` / sandbox answered `403 InvalidProviderToken` with an `apns-id`, ~220–300 ms from EWR). |
| C3 | **Notifications are not stored on Cloudflare.** The Bridge hands the sealed alert to its account object over its socket; the object reads the account's push devices and calls the relay; the APNs payload carries the sealed alert itself and the iOS extension opens it locally. No feed rows, no `/api/notifications/event` fetch. AWS keeps its feed rows (self-host Android polls them) but also puts the sealed alert in the payload, so iOS on both platforms opens alerts without a round trip. Hosted Android notifications stay off (accounts plan D4). |
| C4 | Everything else as recommended in `docs/v2-relay-plan.md` and below. |

## 2. Architecture

```text
App / Bridge ──wss/https──► Worker (agentbaton.app)
                              ├─ static web app (Workers static assets, free)
                              ├─ REST: server/core routes with Cloudflare ports
                              ├─ /ws upgrade: token → account → AccountObject.fetch
                              └─ install script, Bridge package (R2), version
AccountObject  (one per account, SQLite storage, WebSocket Hibernation API)
   ├─ account rows: META, devices, tokens (hashes), push devices        → "store" port
   ├─ relay: forwards frames between this account's sockets only        → "sockets" port
   └─ alerts: sealed alert → push devices → relay binding (no storage)  → "push" port
IndexObject    (sharded by key prefix, SQLite): pairing codes, JOIN# recovery, per-IP rate limits, registration
R2 bucket      attachments (t/<accountId>/…), Bridge package; prefix-scoped temporary credentials
PushRelay      Worker with the APNs key (secret), reached only through a service binding
```

Cost model (measured spike, `docs/v2-relay-plan.md` §3): billing follows incoming WebSocket messages (20 = one
request) and requests; idle hibernated sockets and auto-answered pings cost nothing; egress is free.

## 3. Account object

- **Upgrade**: the Worker parses `accountId` from the token (`bt_<16 hex>_…`; the deployment key of a self-hosted
  Cloudflare install maps to its fixed account), rejects malformed ones, and forwards to
  `ACCOUNT.get(idFromName(accountId))`. The object checks the token hash, role and the Bridge device-name binding
  (same rules as `server/core/auth`), then `acceptWebSocket(server, [role, name])` with
  `serializeAttachment({ role, device, tokenHash, id })`. No location hint: the first connection — normally the
  always-on Bridge — places the object near the computer.
- **Frames**: the same envelope as profile A without the SigV4 wrapper. A Bridge frame names its App target by
  connection id; an App frame names its device. The object only ever delivers to sockets it holds, i.e. to the same
  account (isolation by construction). Unknown or stale targets are dropped (clients already recover from gaps).
- **Control messages on the same socket** (profile A's control socket): `heartbeat` → reply with `bridgeVersion`
  (auto-update trigger); `bridge_join` keys → stored in the attachment, `bridges` list pushed to Apps; a second
  Bridge with the same device name replaces the first (`bridge_replaced`), as `bridge_ws` does.
- **Liveness without alarms**: `setWebSocketAutoResponse(realtime_ping → realtime_pong)`; clients ping every
  25 s. The object never relies on `webSocketClose` alone (measured: dead sockets stayed OPEN for 20+ minutes).
  Instead, whenever it is awake (any incoming frame, REST call or send), it checks
  `getWebSocketAutoResponseTimestamp(ws)`; a socket silent for > 75 s is closed and an App leaving sends
  `peer_left {id}` to the Bridges. No periodic alarm: one alarm per account per minute would cost ≈ $0.0065 per
  account-month, more than all of an account's relay traffic.
- **Subscriptions**: the Bridge keeps its subscriber table, but on Cloudflare drops entries on `peer_left` instead
  of leases; Apps stop renewing (T11, ~2 % fewer messages).
- **Frame limit**: announce `maxFrameBytes = 1 MiB` (incoming limit is 32 MiB; 1 MiB bounds memory per message);
  chunk sizes follow the announcement on both clients.
- **Connection limits** (hosted only; Worker vars `MAX_APPS` = 20, `MAX_BRIDGES` = 5): a 21st App socket is accepted
  and the App with the oldest last activity (any frame but the auto-answered ping; written to the attachment at most
  once a minute) is closed with 4429 `too_many_apps`; the page shows a Reconnect banner and reconnects when shown
  again. A 6th distinct Bridge is closed with 4429 `too_many_bridges` and retries every 10 minutes; the same device
  still replaces its old socket. `monthly_limit` uses the same code (no App reconnect until restart).
- **Rate limit**: `deploy.mjs --rate-limit` adds the zone's one rate-limiting rule (Free plan) for the API host:
  over 200 requests per 10 s from one IP → 429 `{"error":"rate_limited"}` for 10 s. A WebSocket counts once (its upgrade), not per frame.
- **Code updates**: hibernated connections survive deploys; requests may reach the old version for ~20 s after a
  deploy (measured), so the protocol stays backward compatible within a release.

## 4. Storage

| Data | Where | Key |
|---|---|---|
| Account META (current K fingerprint, flags), devices, tokens (hash → kind/role/device), push devices | AccountObject SQLite | per account |
| Pairing codes (15 min, single use), JOIN#<hash(joinSecret)> → accountId, per-IP counters, open-registration counters | IndexObject SQLite, sharded `idFromName('index:' + key[0])` | per key |
| Attachments, Bridge package | R2 | `t/<accountId>/…`, `install/bridge.tar.gz` |

The "store" port of `server/core` is implemented by RPC calls from the Worker to these objects (one DO request
each). Removal + rotation runs as one SQLite transaction inside the account object; the JOIN# change is a second
call to the index object, ordered so a crash leaves the old state valid (same order as PR #229).
Measured: index-object lookups 2–5 ms vs 24–37 ms for D1; both single-use correct (§3 of the plan). The index
object is chosen for consistency and simplicity (one storage technology, nothing extra to provision in the
installer) and latency; sharding by the first hex character (16 objects) is Cloudflare's guidance against one hot
single-threaded object, and costs the same per call.

## 5. Files (R2)

- Clients keep `bridge/transfer-store.mjs`; `presign()` gains an `endpoint` from the server's storage info instead
  of the hard-coded `<bucket>.s3.<region>.amazonaws.com`. Everything else was verified unchanged on R2:
  `x-amz-checksum-sha256` (BadDigest on wrong bytes), HEAD with checksum mode, `x-amz-meta-sealed` + CORS expose,
  Range 206, response overrides.
- Credentials: the Worker issues R2 temporary credentials scoped to `t/<accountId>/` (Cloudflare API, 1 h), cached
  per account in the object; outside the prefix → 403 (verified).
- Retention (hosted): lifecycle 1 day; the Bridge deletes a phone → computer upload once it has stored it. Self-host
  on AWS keeps 7 days. Old attachments fall back to the Bridge's local copy (check every entry point); a missing
  Bridge → App object is simply uploaded again on the next open (content-hash HEAD misses).
- No size rule for cost: R2 bills the daily peak (a 1 GB file kept a day ≈ $0.0005) and ingress is free. Abuse is
  bounded later by a per-account daily upload quota (phase 4 limits), sized from measured usage.

## 6. Notifications (C3)

```text
Bridge notify.mjs ──socket {action:'alert', alert(sealed e)}──► AccountObject
   viewed check (notify_check/notify_seen, unchanged) → push devices (SQLite) → env.PUSH.send({token, environment, alert})
PushRelay Worker: APNs JWT (ES256, WebCrypto, cached 50 min) → fetch https://api.push.apple.com/3/device/<token>
   payload { aps: { alert: placeholder, mutable-content: 1 }, id, e, … clear routing fields }  (≤ 4 KB)
iOS NotificationService: open `e` from the payload with the shared-keychain key; on failure, fetch by id (AWS) or
   keep the placeholder.
```

- Same relay contract on both platforms: optional `alert` next to `id`; the Lambda relay accepts it too (AWS
  servers send both; rows stay for Android).
- Bad device tokens (410 Unregistered) remove the push device, as today.
- Queued alerts while the Bridge is offline keep the existing Bridge-side queue (`notify.mjs`).
- Android (hosted): the foreground service holds its own `role=notify` relay socket instead of polling the feed;
  the object pushes each sealed alert to it (nothing is stored; a disconnected socket misses it) and Kotlin
  opens it as today. Self-hosted AWS keeps the feed. Before any push, `notify_check` goes to every App socket
  (`{to:'apps'}`); a focused App shows it in-app and answers, and then nothing is pushed (docs/mobile-notifications.md).

## 7. Clients

- **Announcement**: `/devices` (and the existing whoami) return `transport: 'relay'`, `relay.url`,
  `maxFrameBytes`; profile A returns what it does today.
- **App** (`web/js/v2/direct-transport.js`): on `relay`, one socket `wss://<host>/ws?apiKey=…&role=app`, frames
  sent as JSON without signing, no STS credentials or `rpc_join`, no lease renewals, ping 25 s (auto-pong).
- **Bridge** (`bridge/ws.mjs` control + `bridge/direct-rpc.mjs` data): on `relay`, one socket carries both; the
  data path's signer becomes a plain send; credentials requests disappear; reconnect gets jitter (0–5 s) and
  backoff; ping 25 s.
- **Preview**: `PREVIEW_ACK_BYTES` / chunk size from `maxFrameBytes` (e.g. 256 KB chunks, ack per 1 MB) — fewer
  messages, which is what Cloudflare bills.
- **iOS extension**: open from payload first (C3).

## 8. Web app, install, version

- Static assets (free and unlimited when no Worker code runs; an R2 public bucket would bill Class B reads and has
  no SPA routing): `assets.config` with `html_handling: "none"` + `_headers` (immutable hashed assets, `no-cache`
  HTML) to match #191 without a Worker invocation per file — verify `/setup` → 404; fall back to wrapping
  `env.ASSETS` if not.
- `/install`, `/auth/install`, `/api/version` from `server/core`; the Bridge package from R2.
- `APP_VERSION` is a Worker variable set by the deploy script.

## 9. Deployment in PR 2

A development deploy script (`server/cloudflare/deploy.mjs`, Cloudflare API, no wrangler) that PR 2's tests use;
the user-facing one-line installer comes in phase 2 and reuses it. Resources: Worker (+ static assets, DO classes
AccountObject/IndexObject with SQLite migrations, R2 binding, service binding to the relay), PushRelay Worker
(APNs key as secret), R2 bucket with CORS + lifecycle, custom domain.

## 9a. Domains (user, 2026-11-17)

| Host | Serves |
|---|---|
| `api.agentbaton.app` | REST + `/ws` (App and Bridge); the only server URL clients store |
| `web.agentbaton.app` | the browser Web App (static assets) and pairing links / QR codes (later also the Universal / App Links verification files) |
| `agentbaton.app` | future marketing homepage (not in PR 2), except `/install` and `/install.ps1`, which reach the service Worker and print scripts pointing at `api.agentbaton.app` |
| `www.agentbaton.app` | 301 → apex |
| `api-jp.agentbaton.app` | the same API through the Tokyo relay, for callers in mainland China only (DNS-only, [v2-cn-relay.md](v2-cn-relay.md)) |

- One Worker with several custom domains; the hostnames are deploy-script parameters (`--api-domain`, `--web-domain`,
  `--install-domain`). PR 2 tests with `pr2-api.agentbaton.app` + `pr2-web.agentbaton.app`; the production names are
  attached at launch.
- Self-host AWS keeps one origin for both. The Web App takes its API base from `<meta name="baton-api">`, which the
  Cloudflare deploy fills in when the web and API hosts differ (empty: same origin). Pairing links carry the API
  server (`s=`) when it is on another origin than the link. The API already answers CORS for any origin (preflight
  with `Access-Control-Max-Age`, as the native app needs).

## 10. Tests and acceptance

- Contract suite from PR 1 passes against the Cloudflare deployment.
- New, Cloudflare only: cross-account frame isolation (two accounts, a Bridge of A cannot reach an App of B by any
  `to`), stale-socket cleanup (`peer_left` after a silent App), token-in-URL routing, alert without storage.
- End to end with a test box: chat, terminal, preview, files (R2), notifications on a real iPhone (TestFlight build
  with the extension change), device removal + rotation, account deletion; frame counts via `frame-stats`.
- Mainland China: the user's phone on reach-style test page for the final domain.

## 11. Size estimate

| Part | Lines |
|---|---|
| `server/cloudflare/` (Worker entry, AccountObject, IndexObject, R2 credentials, ports) | ~700 |
| `push-relay/worker.mjs` (APNs over fetch, WebCrypto JWT) + Lambda relay accepting `alert` | ~140 |
| Clients: App transport, Bridge single socket + jitter, transfer-store endpoint, preview sizes | ~400 |
| iOS NotificationService: open from payload | ~20 |
| `server/cloudflare/deploy.mjs` (dev deploy) | ~150 |
| Tests (Cloudflare-only cases) | ~150 |
| **Total** | **~1,550** |

## 12. Open (to verify while implementing)

1. `html_handling: "none"` gives 404 for unknown paths such as `/setup`.
2. R2 temporary-credential issuance latency and rate limits; cache per account.
3. APNs payload size with the sealed alert for the longest titles (stay < 4 KB, clip as today).
4. Self-hosted Cloudflare installs (phase 2) cannot bind to the hosted relay: decide then (public relay route with a
   per-install credential, or the AWS relay).

## 13. Changes from the pre-tests (2026-11-17, measured; scripts in agentpeek-v2-relay/.scratch/pr2-verify/)

These override the sections above where they differ.

1. **Static assets (§8)**: `html_handling: "none"` alone answers `/` with 404. Use `none` + the `_headers` below +
   a tiny Worker that only maps `/` to `/index.html` (asset hits still run no Worker code). Upload with a real MIME
   type per file. HTML loses its ETag at the edge (always a full 200) — accepted.
   `/*  ! Cache-Control` · `/*.html  Cache-Control: no-cache` · `/assets/*.js|css  public, max-age=31536000, immutable`.
2. **Frames (§3)**: 1 MiB passes both ways (p50 73–87 ms); the real limit is 32 MiB − 72 B and oversize frames are
   dropped silently in both directions, so senders check `maxFrameBytes` themselves and the object closes a peer
   that exceeds it.
3. **Liveness (§3)**: `getWebSocketAutoResponseTimestamp` works (updated per auto-answered text ping, survives
   hibernation, null before the first ping → use the connect time). Protocol-level pings neither update it nor wake
   the object, so every client sends the text `{"action":"realtime_ping"}`. A dead TCP socket stays in
   `getWebSockets()` as OPEN for ~8–9 min and its `webSocketClose` arrives ~9 min late: the sweep marks
   `closing` in the attachment before `close(4000)`, routing skips `closing` sockets, every send is in try/catch,
   `peer_left` is de-duplicated. A room of ping-only sockets never wakes the object, and no alarm keeps it awake
   (each `setAlarm` is a billed row write): the sweep runs on every request and frame, so a dead App goes at the
   next one after 75 s, at the latest with the Bridge's 4-minute heartbeat (AWS: lease 150 s).
4. **Auth (§3)**: browsers and Node cannot read an upgrade's 401/403, so a revoked token would look like a network
   error and retry forever. The object accepts the upgrade and closes with **4401** (bad/revoked token) or **4403**
   (wrong role/device); clients stop retrying on those codes. Malformed tokens are still rejected by the Worker.
5. **Placement (§3)**: cross-region calls add ~175 ms (REST RPC 17–19 ms local vs ~180–190 ms). The account
   object is first touched by the pairing Bridge (its `pair/start` and first connect go to the account object), so
   it lands near the computer; no hint otherwise.
6. **Deploys (§3, §9)**: hibernated sockets survive; sockets on an active object run old code up to 300 s
   (`deferred`) and then drop with 1006 (no `webSocketClose`). Clients treat 1006 without reason as
   reconnect-and-resume (they do today); the protocol stays compatible across at least two consecutive versions.
   The deploy script uses `POST …/versions` then `POST …/deployments` and checks the new version is live (two plain
   uploads silently produced no new version).
7. **APNs payload (§6, §12-3)**: current clipping counts code points, not bytes — worst case 6,013 B (emoji/control
   characters) > 4,096. Drop the duplicate `title` from the sealed part and cap fields by JSON-escaped UTF-8 bytes
   (`projectHash` ≤ 400, `projectName` ≤ 240, `sessionTitle` ≤ 360, `body` ≤ 900) → worst case 3,801 B. Both relays
   reject requests > 4 KB of payload; the Lambda relay's 1,024 B request limit rises to 8 KB.
8. **CPU (Free plan: 10 ms CPU per request; Paid: 30 s, 30M CPU-ms/month included)**: warm handlers p50
   0.3–0.7 ms, p99 ≤ 2.2 ms; keep p99 < 5 ms and avoid heavy libraries.
9. **R2 credentials (§5, §12-2 closed)**: issuance p50 424 ms / p95 738 ms, 50 parallel fine, limit 1,200 calls per
   5 min per token (shared with other API calls), usable immediately, no expiry in the response. Policy: 1 h per
   account, prefix **with trailing slash** `t/<accountId>/`, expiry computed by us (−30 s), refreshed early, one
   refresh in flight per account, keep the old one on 429/5xx, clients retry once with fresh credentials on 403.
   Presigned URLs die with their credentials; revocation is only possible for all credentials at once.
10. **APNs from a Worker (§6)**: real pushes to the user's iPhone returned 200 and arrived (Worker fetch ~75 ms
    from IAD). APNs rejects provider tokens refreshed more often than every 20 minutes (`TooManyProviderTokenUpdates`),
    so the relay must not sign per request: one `ApnsToken` Durable Object holds the current JWT (re-signed every
    ~40 min) and each isolate caches it in memory. The APNs key is a Worker secret of the relay only (encrypted by
    Cloudflare, readable by that Worker's code, never shown again), as the Lambda reads it from an SSM SecureString.
11. **CPU**: server-side lists are already small and bounded (devices, push devices, feed `Limit=100`); Session,
    project and history lists come from the Bridge over the socket, not from the server.

## 14. Monitoring and the monthly cost cap (hosted service)

- **Monitor Worker** (`server/cloudflare/monitor.mjs` + `monitor.html`, `deploy.mjs --monitor <host> --admin-email <address>`):
  its own custom domain behind Cloudflare Access (email one-time PIN, only `--admin-email`). The Worker also checks the
  `Cf-Access-Jwt-Assertion` (audience + issuer + signature), so the page and `/api/data` are never served without Access.
  The one exception is `<monitor>-report.<zone>`: only `POST /relay/report`, with the `RELAY_REPORT_KEY` bearer key, takes the
  mainland-China relays' 5-minute traffic reports (docs/v2-cn-relay.md).
  The workers.dev route stays off. State lives in one SQLite object, `MonitorStore`: 35 days of 5-minute snapshots, alert
  state, blocked accounts.
- **Every 5 minutes**:
  - Probes: `/api/version`, REST through the probe account's object, and a WebSocket `realtime_ping` → `realtime_pong`.
    The probe account is registered by the deploy, and its token is a secret.
  - One GraphQL query covers the account objects and the service totals.
  - The cap is enforced, a snapshot is written, and alerts are evaluated.
- **Plan** (`--plan free|paid`, default free): quotas are the Free plan's limits (mostly per day) or Workers Paid's
  monthly included usage. The headline cost is list-price usage on Free and the bill on Paid ($5 + usage beyond the
  included amounts, account-wide). Prices and quotas are in `cost.mjs`, with the source pages.
- **Alerts**: one email per run (Email Routing `send_email`) to the verified `--admin-email`. Each alert is keyed so it
  fires once. Triggers: two failed probes in a row (and recovery), error rate > 5 % over 15 min, any Free quota > 80 %,
  an account blocked, monthly usage over `--cost-alert`. `support@<zone>` forwards to the same address.
- **Measured (2026-11-19)**:
  - Messages on hibernatable sockets appear as `hibernation` invocations of `durableObjectsInvocationsAdaptiveGroups`;
    `inboundWebsocketMsgCount` stays 0 for them. Auto-answered pings appear in neither.
  - The `alarm` invocation type gives "accounts with an App open" (alarm every 60 s while Apps are attached). Accounts
    with any invocation in 5 min approximate Bridges online (heartbeat every 4 min).
  - ASN / carrier is not available from the Free zone's `httpRequestsAdaptiveGroups`, so it comes from the
    usage points' `request.cf.asOrganization`.
  - An unknown script name empties a `scriptName_in` filter, and a null variable drops a filter entirely. The deploy
    lists only existing Workers, and the monitor refuses to run without its namespace ids.
- **Usage points** (Workers Analytics Engine, `USAGE`, dataset `<name>_usage`; `usage.mjs`). Server side only: no content,
  and accounts appear only as `sha256(accountId)[:16]`. Points:
  - `active`: once per account and UTC day, at the first App. Carries platform from the User-Agent, country, network,
    and whether the account is new.
  - `bridge`: once per device and day. Carries version and OS.
  - `summary`: when the last App leaves, at most hourly, or at the next day's first connect. Carries today's App seconds
    and the App count.
  - `conn` / `reject`: 1 in 10, with weight 10.
  Usage state costs one SQLite write per App socket close. Use time is App connection seconds, summed over that day's connections.
- **Cost cap**:
  - Per account object, month to date at list price: Worker request per HTTP invocation + DO requests (non-hibernation
    invocations + WebSocket messages / 20) + GB-s + SQLite rows. This is the union of the top 100 by duration, by
    messages and by calls.
  - The cap leaves out calls (`capCost`): refused upgrades with a guessed account id are cheap to send and priced as
    requests. The duration and rows such a refusal adds are about a thousand times below its request price, and the per-IP
    rate limit bounds them.
  - The block covers the relay; REST stays open. The dashboard can lift a block, and two failed usage runs in a row
    alert, because the cap is off while they fail.
  - An object over `--cost-cap` (default $1) gets `AccountObject.monthlyLimit(until 1st of next month UTC)` through the
    monitor's binding to the service's namespace (`script_name`; no public route reaches it). That closes every socket
    with **4429 `monthly_limit`**, refuses new upgrades with the same close, and persists the block in the object's
    storage. The block lapses by itself when the month changes.
