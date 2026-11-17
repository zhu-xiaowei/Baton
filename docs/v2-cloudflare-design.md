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
- **Code updates**: hibernated connections survive deploys; requests may reach the old version for ~20 s after a
  deploy (measured), so the protocol stays backward compatible within a release.

## 4. Storage

| Data | Where | Key |
|---|---|---|
| Account META (current K fingerprint, flags), devices, tokens (hash → kind/role/device), push devices | AccountObject SQLite | per account |
| Pairing codes (10 min, single use), JOIN#<hash(joinSecret)> → accountId, per-IP counters, open-registration counters | IndexObject SQLite, sharded `idFromName('index:' + key[0])` | per key |
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
- Follow-up (phase 4, D5): Android's existing foreground service holds the App's relay socket instead of polling
  the feed (idle sockets are free on Cloudflare and ≈ $0.012/device-month on API Gateway vs ≈ 170k feed requests);
  the object pushes the sealed alert to it and Kotlin opens it as today. Then AWS needs no feed rows either.

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
