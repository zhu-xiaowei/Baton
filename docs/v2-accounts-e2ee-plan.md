# v2 phases 2 + 3: accounts, pairing, multi-tenancy and end-to-end encryption

Status: plan, 2026-11-12; decisions confirmed (§10). Phases 2 and 3 of `docs/v2-architecture.md` §14 are built together; phases 4
(EC2 relay, hosted profile B) and 5 (store release) come after, together. This plan narrows §6, §7, §8
and §12 of the architecture doc to what the code needs now. Each section ends with the open decisions.

## 1. Goal and scope

- A computer and a phone are paired by scanning a QR code; no AWS account, API key or registration is
  needed on the hosted service (§7). Self-host keeps working with its API key.
- Every content payload between App and Bridge is end-to-end encrypted; the relay (API Gateway + Lambda
  today, the EC2 relay in phase 4) routes on clear envelope fields only (§5, §6).
- One stack can hold many accounts with no way for one account to read, inject into or list another's
  data, proven by one cross-account test suite (§12).
- Out of scope here: the EC2 relay itself, CloudFront origin switch, store submission, billing, email.

Profile A stays the only implementation in these phases. A multi-account profile-A stack is for testing
only: §12 item 8 (STS credentials cover the whole data API) allows bandwidth abuse between accounts, which
encryption does not stop. The public hosted service waits for the EC2 relay (phase 4), which authorizes
every frame itself.

## 2. Where the code is today (feat/v2, 2026-11-12)

| Area | Today | File |
|---|---|---|
| Auth | One API key per stack; `accountId` = SHA-256(key)[:16], pinned as a stack parameter; Lambdas read the key from API Gateway | `server/src/api_key.py` |
| Sign-in | Setup's Start URL / QR / install command share a 10-minute start token; `/auth/exchange-token` returns the API key | `server/src/main.py` (`start-token`, `exchange-token`, `/auth/install`) |
| Devices | `DEVICE#<account>/<device>` rows in SystemTable, written by WS `$connect`; `/devices`, `device-name/validate`, `delete-device` | `server/src/devices.py`, `bridge_ws.py` |
| Direct channel | App and Bridge get STS credentials (`issue_credentials`) scoped to the data API (+ S3 `t/<account>/`); every frame is SigV4-signed and forwarded by API Gateway without Lambda | `server/src/direct_rpc_ws.py`, `bridge/direct-rpc*.mjs`, `web/js/v2/direct-transport.js` |
| Frames | `rpc`, `rpc_result`, `push`, `stream` bodies; payloads deflated and chunked | `bridge/direct-rpc-protocol.mjs` |
| Files | S3 transfer area `t/<accountId>/<key>`, client-signed, content-hash keys, 7-day lifecycle | `bridge/transfer-store.mjs` |
| Notifications | Bridge decides and posts `/api/bridge/notify`; events stored as plain text (`NOTIFICATIONS#…`, 7 days); push devices in ONE shared `PUSH_DEVICE` partition; iOS via the shared APNs relay; Android polls the event feed | `server/src/notifications.py`, `push-relay/` |
| Per-device credentials | `feat/device-credentials` (2 commits, +1222/−148, not merged): device-level credentials listed and revoked in Setup | branch `feat/device-credentials` |

## 3. Identity and keys

- **Account key `K`**: 256 random bits, created by the first Bridge of a hosted account, stored in Bridge
  `config.json` (0600), the iOS Keychain (shared access group, so the Notification Service Extension can
  read it), Android Keystore-wrapped storage, and desktop/web storage (see decisions).
- **Derived with HKDF-SHA256** (`info` strings fixed in code): `accountId` (16 bytes, hex), `joinSecret`
  (registers and proves the account to the server), and `dataKey` (AES-256-GCM, `keyId` = generation of `K`).
  The server stores `accountId` and `hash(joinSecret)` only; it never sees `K`. `accountId` is derived once,
  at registration, and kept as a fixed identifier afterwards (it survives rotation).
- **Rotation replaces `K` itself**: removing a device creates a fresh random `K'` (new `joinSecret`,
  `dataKey`, recovery phrase); the server swaps `hash(joinSecret)`; the remaining devices receive `K'` over
  their live forward-secret sessions (§6), never under the old `dataKey`. Rotating only the data key is not
  enough: a removed device still holding `K` could re-derive `joinSecret` and come back through recovery.
  Devices keep the previous key for in-flight frames only.
- **`K` never reaches logs**: Bridge prints the pairing QR code only to an interactive terminal (the install
  command, `baton-bridge pair`), never to the service's stdout (journald / launchd / Task Scheduler logs).
- **Recovery phrase**: `K` encoded as 24 words. Needs a word list; BIP-39's English list is public domain
  text, embedded as data (not a dependency).
- **Self-host**: keeps the API key for authentication. Encryption uses the same scheme with a `K` created
  by the first Bridge of the stack and carried in the Setup QR code (decision D1).

## 4. Tokens and the server side

Everything new lives in SystemTable (no new table):

| Row | Content | TTL |
|---|---|---|
| `ACCOUNT#<accountId>` | `joinSecretHash`, created, plan limits | — |
| `TOKEN#<sha256(token)>` | `accountId`, `deviceName`, kind (`app`/`bridge`), created, lastSeen | — |
| `PAIR#<sha256(code)>` | `accountId` (unset until approved for a joining computer), kind, sealed `K`, expires; deleted on use | 10 min |
| `PUSH_DEVICE#<accountId>` | replaces the shared `PUSH_DEVICE` partition (§12 item 3) | — |

- **Auth middleware**: REST and WS `$connect` accept `Authorization: Bearer <token>` (hosted) or
  `x-api-key` (self-host); both resolve to an `accountId` once, and every handler takes the account from
  there, never from the request body.
- **Endpoints** (REST, small):
  - `POST /api/account/register {accountId, joinSecret}` — Bridge, rate-limited per IP; returns a Bridge token.
    Only once per account: an existing `accountId` is rejected.
  - `POST /api/account/recover {accountId, joinSecret}` — separate route, rate-limited per IP and account;
    tells the account's other devices that the account was recovered.
  - `POST /api/pair/create {kind, sealed}` — authenticated device; returns a single-use pairing code.
  - `POST /api/pair/claim {code, deviceName}` — the new device; returns its token and the sealed key.
  - `POST /api/pair/start`, `/api/pair/wait`, `/api/pair/approve` — a new computer joining (§5 item 3).
  - `GET /api/tokens`, `POST /api/tokens/revoke` — the device list and revocation (merged into `/devices` if simpler).
  - `POST /api/account/delete` — removes account, tokens, push devices; tells Bridges to forget `K`.
- **STS credentials** stay as today (scoped per account for S3; whole data API for `@connections`, §12 item 8),
  issued only to valid tokens and dropped on revoke (`$disconnect` + no renewal).
- Reuse `feat/device-credentials` where it fits; review it first, do not merge it wholesale.

## 5. Pairing flows (§7)

A QR code never contains `K`. It holds `https://<server>/pair#c=<code>&t=<t>`: a single-use pairing code and
16 random bytes `t` in the URL fragment (never sent to a server). `K` travels as `AES-GCM(HKDF(t), K, AAD =
code)`, kept by the server in the `PAIR#` row and deleted when the code is used or expires (10 min). The
server never has `t`, so it can neither read `K` nor forge a sealed key; a photo of a used or expired code is
worthless. The scanner checks that `accountId` derived from `K` equals the one the server returned. Scanning
is the consent: there is no confirmation dialog; the App shows "Added *name*" afterwards and the device
appears in the device list (removal rotates `K`).

1. **First computer**: the install command starts Bridge; Bridge creates `K`, registers, seals `K` under a
   fresh `t` (`POST /api/pair/create {kind: app, sealed}`) and prints the QR code in the terminal (and a
   copyable link), refreshed when it expires. The App's first screen is "Scan the QR code on your computer"
   (secondary: "Use my own server"); it scans, `POST /api/pair/claim {code, deviceName}` returns its token,
   `accountId` and the sealed key, and the App opens `K` with `t`.
2. **Another phone / tablet / desktop App**: a signed-in native App ("Add device") or any Bridge
   (`baton-bridge pair`) shows a QR code the same way. The browser App cannot (D2: `K` not extractable).
3. **Another computer**: its Bridge has no `K`. It calls `POST /api/pair/start {deviceName}` (no credential,
   rate-limited per IP), prints the QR code with its own `t`, and polls `POST /api/pair/wait`. A signed-in
   App scans it and sends `POST /api/pair/approve {code, sealed}` with `K` sealed under that `t`; the server
   binds the code to the App's account and issues the Bridge token, which the waiting Bridge receives with
   the sealed key. The terminal then shows "Joined, approved by *iPhone*".
4. **Recovery**: entering the 24 words recreates `K`, `accountId` and `joinSecret`; the server issues a new
   App token (`/api/account/recover`, §4).
- The Bridge also needs a CLI entry to show a pairing QR code again (`baton-bridge pair`), since the install
  terminal may be gone.
- QR codes are printed only to an interactive terminal (§3). The terminal rendering uses `qrcode-terminal`
  0.12.0 (MIT, no dependencies), the package `server/install.sh` already installs on the fly for its Start
  URL; it becomes a Bridge dependency in PR 3 (approval pending).

## 6. Encryption on the wire (§6)

- **Where**: in `bridge/direct-rpc-protocol.mjs` (shared by Bridge and App), around the existing
  compress-and-chunk step: `payload → deflate → AES-256-GCM(sessionKey, nonce) → base64 → chunks`. One place
  covers `rpc` params, `rpc_result`, `rpc_progress`, errors, `push` and `stream` (`m` of terminal/preview
  frames). Only WebCrypto (App) and `node:crypto` (Bridge, synchronous so frame order is kept); no dependency.
- **Session keys (forward secrecy)**: each App process and Bridge process pair runs one handshake in the
  TLS 1.3 `psk_dhe_ke` pattern (equivalently Noise NNpsk0): both sides send an ephemeral ECDH P-256 key;
  `sessionKey = HKDF(salt = hash(transcript), ikm = ECDH ‖ dataKey)`, with one key per direction. Ephemeral
  private keys are discarded after the handshake, so a later leak of `K` does not decrypt recorded traffic;
  the per-key random-nonce budget (2³² messages) applies per session, not per account. Session keys live in
  memory only: an App socket reconnect keeps them; an App cold start or a Bridge restart makes a new one.
- **No extra round trip (0-RTT)**: the handshake rides on the first request the App sends to that Bridge
  after start — in practice `home` (sent to every online Bridge in parallel), otherwise `subscribe`/history,
  `projects`/`sessions`, or the request retried after a Bridge epoch change. That first request carries the
  App's ephemeral public key in the clear envelope and is encrypted under a key derived from `dataKey`;
  concurrent requests before the reply reuse the same ephemeral key and the Bridge makes one session per key.
  The reply carries the Bridge's ephemeral key and is already under the session key. A Bridge that does not
  know a session (restarted) answers "handshake required" and the App's existing epoch-change retry carries a
  new handshake.
- **0-RTT only for read-only methods** (RFC 8446 §8): `home`, `projects`, `sessions`, `threads`, `subscribe`,
  `unsubscribe`, history, `tool_details`, command lists, file and Git reads. Requests with side effects
  (`send_message`, `interrupt`, permission replies, file deletion, commit/push, terminal input, project
  creation) wait for the session; if one is the very first request, the transport sends a standalone
  handshake first. Terminal and preview streams always use the session key.
- **Replay**: every sealed payload carries a per-session, per-direction sequence number inside the
  ciphertext; the receiver keeps a sliding window (DTLS / IPsec anti-replay) because profile A delivers
  frames out of order. No clock is involved. Old sessions cannot be replayed into new ones (different keys).
- **Static `dataKey` is used only where no handshake is possible**: the 0-RTT request itself, notifications
  (the phone may be offline), and attachments at rest in S3. Those have no forward secrecy, as in every
  comparable product.
- **Clear envelope**: `v`, `kind`, `method`/`event`, `requestId`/`id`, `sessionId`, `chunk`, `keyId`,
  `from`/`replyTo`, and the handshake's ephemeral public keys. Everything else is ciphertext.
- **AAD**: `kind`, `method|event`, `requestId|id`, `sessionId` (and `ch`, `id` for streams). A payload is
  encrypted once before chunking, so `chunk.index` is not in the AAD; swapped or missing chunks fail the tag.
- **Nonce**: random 12 bytes per encrypted payload. Ciphertext layout `nonce ‖ ciphertext ‖ tag`.
- **Stream messages**: plaintext is `JSON(header) ‖ "\n" ‖ raw data bytes`, so terminal data is base64-encoded
  once, as today.
- **Budget**: the signed frame limit (28 KiB) already leaves room; RPC chunks keep `deflate-b64`'s 20000
  characters, stream messages keep `PACKED_MAX_CHARS`.
- **Failure**: a payload that fails to decrypt, or replays a seen sequence number, is dropped and counted; it
  never reaches handlers (this is also the defence against injected frames from another account, §12 item 8).
  With a key configured, clear frames are dropped too (D3: no mixed window).
- **Compress, then encrypt** stays (traffic and per-32 KB charges): the length leak (CRIME class) needs an
  attacker who controls the relay and injects chosen text into the same payload; accepted and stated in
  SECURITY.md.
- **Attachments**: client-side encryption before the S3 PUT; files are chunked (e.g. 1 MiB GCM records)
  because WebCrypto has no streaming AEAD; the content-hash key becomes `HMAC(dataKey, sha256(file))`
  so dedup stays per account (§6 "Attachments"). The S3 checksum then covers the ciphertext.
- **Notifications**: Bridge encrypts title and body; the server stores and forwards ciphertext only (§12
  item 4); the iOS NSE and Android decrypt with `K` from shared storage.

## 7. Multi-tenancy audit (§12)

A checklist, each item with a test in the cross-account suite (two accounts on one test stack):
1. Every REST route and WS route resolves the account from the credential and scopes all reads/writes.
2. `$connect` rejects unknown/revoked tokens; revoked devices lose their sockets and credentials.
3. Device names, routes (`rpc.bridges`) and pushes never cross accounts; a request addressed to another
   account's Bridge connection is rejected by the receiving side (decrypt failure) — and the attempt is
   rate-limited and logged.
4. S3: STS policy limited to `t/<accountId>/`; cross-account GET/PUT/HEAD return 403 (already true).
5. Push devices per account (`PUSH_DEVICE#<accountId>`); notification events stored encrypted.
6. Lambda log groups retention 7 days; no payload content logged.
7. Abuse limits: account creation per IP, ≤3 computers per free account, per-token request rate,
   accounts with no paired phone removed after 24 h.

## 8. App changes

- First-run screen (scan / paste link / "Use my own server"), "Add computer" confirmation, device list
  with revoke, recovery phrase display and entry, account deletion (App Store requirement).
- Key storage per platform and its exposure to the NSE (iOS) and the Android notification path.
- Every existing data path is unchanged above `direct-transport.js`; encryption is inside the protocol layer.

## 9. Work order (one PR each, into feat/v2)

1. **Crypto core**: HKDF derivations, AES-GCM payload seal/open with AAD, the session handshake (0-RTT for
   read-only requests) and the replay window, wired into `direct-rpc-protocol.mjs` behind a key (no key =
   today's behaviour); Node + browser; ≈15 lines of tests for round-trip, tamper, wrong key and replay.
2. **Tokens + account rows + auth middleware** (server), keeping API-key mode; `$connect` by token.
3. **Pairing**: register, pair create/claim, Bridge QR (terminal + CLI), App scan/link screens.
4. **E2EE on**: Bridge and App exchange `K` through pairing; self-host QR carries `K`; every payload
   encrypted; terminal/preview included.
5. **Device management + rotation + account deletion**.
6. **Notifications**: encrypted payloads, per-account push devices, NSE decryption, Android decision (D4).
7. **Attachments encryption**.
8. **Cross-account test suite + §12 fixes** (logs, limits), run on a two-account test stack.

Each PR: implement → self-test on a test stack → independent review (reproducible findings only) →
fix → acceptance through the real Baton API → merge on the user's OK.

## 10. Decisions (confirmed 2026-11-12)

- **D1** Self-host is encrypted by default: a random `K` from the first Bridge; the first App scans that
  Bridge's terminal QR code exactly as on hosted. The API key only authenticates.
- **D2** The browser Web App stays, with `K` as a non-extractable `CryptoKey` in IndexedDB: it cannot pair
  other devices or show the recovery phrase and re-pairs on loss. Tauri desktop Apps store an extractable `K`.
- **D3** No mixed encrypted/unencrypted window: one coordinated update of Bridge, server and App (new
  TestFlight build at the same time).
- **D4** Hosted Android notifications are off in these phases; FCM vs. a socket is decided with phase 4
  (FCM is a new dependency and needs approval). Self-host Android keeps polling and decrypts the payload.
- **D5** `feat/device-credentials` is not rebased (built on v1, all credentials in one `CRED` partition).
  The smaller version here borrows: the cached `resolve()` with hourly `lastUsedAt`, atomic one-time token
  consumption (conditional delete with `ALL_OLD`), first-use device binding, API Gateway throttling,
  `ApiKeyRequired:false` + middleware, the Bridge's key → token migration, and its test cases.
- **D6** The recovery phrase is shown only on request (Settings, after confirmation). Any Bridge holds `K`
  and can show a pairing QR code again, and the server keeps no conversation data, so the phrase is only
  needed when every device is lost.
- Also confirmed: rotation replaces `K` (§3), QR codes never in logs (§3), register-once + separate
  recovery route (§4), forward-secret session keys with 0-RTT for read-only first requests, and the
  sequence-number replay window (§6).

## 11. Comparison with competitors (source read 2026-11-12, HEAD of each repository)

| | Happy (`slopus/happy`) | Paseo (`getpaseo/paseo`) | Baton (this plan) |
|---|---|---|---|
| Content cipher | AES-256-GCM (legacy NaCl secretbox), **no AAD** | Noise NK, ChaCha20-Poly1305 (legacy NaCl box) | AES-256-GCM with AAD |
| Root secret | 32 random bytes = the account | one long-term daemon X25519 key | 32 random bytes `K` |
| Server/relay auth | Ed25519 challenge → token | **none**: knowing `serverId` lets anyone replace or join sockets | per-device tokens |
| Adding a device | QR + public-key sealing; relayed key not verified | everyone scans one static link | QR; the public key is scanned, not relayed |
| Device removal / rotation | none | none | `K` rotated, delivered over forward-secret sessions |
| Replay | none (server `seq` / `localId` dedup only) | counters; any reorder closes the channel | sequence window tolerant of reordering |
| Forward secrecy | none | per connection | per App/Bridge session, 0-RTT for reads |
| Push content | **plain text** | — | encrypted |
| Recovery | base32 secret | none | 24 words |
| Compression | none | none | deflate before encryption (accepted, §6) |

Happy authenticates with a signature where Baton sends `joinSecret` once per register/recovery (stored as a
hash, replaced on rotation); the two are equivalent in practice, so `joinSecret` stays.
