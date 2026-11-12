# v2 phases 2 + 3: accounts, pairing, multi-tenancy and end-to-end encryption

Status: plan, 2026-11-12. Phases 2 and 3 of `docs/v2-architecture.md` §14 are built together; phases 4
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
  (registers and proves the account to the server), and `dataKey_n` (AES-256-GCM key for `keyId` n).
  The server stores `accountId` and `hash(joinSecret)` only; it never sees `K`.
- **Rotation**: removing a device creates `dataKey_{n+1}` from fresh randomness (not from `K`), sent to
  the remaining devices encrypted under `dataKey_n`; `keyId` travels in every envelope. Devices keep the
  previous key for in-flight frames only.
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
| `PAIR#<sha256(code)>` | `accountId`, kind, expires, used | 10 min |
| `PUSH_DEVICE#<accountId>` | replaces the shared `PUSH_DEVICE` partition (§12 item 3) | — |

- **Auth middleware**: REST and WS `$connect` accept `Authorization: Bearer <token>` (hosted) or
  `x-api-key` (self-host); both resolve to an `accountId` once, and every handler takes the account from
  there, never from the request body.
- **Endpoints** (REST, small):
  - `POST /api/account/register {accountId, joinSecret}` — Bridge, rate-limited per IP; returns a Bridge token.
  - `POST /api/pair/create {kind}` — authenticated device; returns a single-use pairing code.
  - `POST /api/pair/claim {code, deviceName, kind}` — the new device; returns its token.
  - `GET /api/tokens`, `POST /api/tokens/revoke` — the device list and revocation (merged into `/devices` if simpler).
  - `POST /api/account/delete` — removes account, tokens, push devices; tells Bridges to forget `K`.
- **STS credentials** stay as today (scoped per account for S3; whole data API for `@connections`, §12 item 8),
  issued only to valid tokens and dropped on revoke (`$disconnect` + no renewal).
- Reuse `feat/device-credentials` where it fits; review it first, do not merge it wholesale.

## 5. Pairing flows (§7)

1. **First computer**: the install command starts Bridge; Bridge creates `K`, registers, and prints a QR
   code in the terminal (and a copyable link) with `{server, pairing code, K}`. The App's first screen is
   "Scan the QR code on your computer" (secondary: "Use my own server").
2. **Another phone / tablet / desktop App**: a signed-in device shows a QR code with `{server, code, K}`.
3. **Another computer**: its Bridge has no `K`; it prints a QR code with `{server, code, P-256 public key}`.
   A signed-in phone scans it, confirms "Add computer *name*?", and sends `K` encrypted to that key
   (ECDH P-256 → HKDF → AES-GCM, WebCrypto) through the relay. The relay cannot swap the public key
   because it was scanned.
4. **Recovery**: entering the 24 words recreates `K`, `accountId` and `joinSecret`; the server issues a new
   App token.
- The Bridge also needs a CLI entry to show a pairing QR code again (e.g. `baton-bridge pair`), since the
  install terminal may be gone.

## 6. Encryption on the wire (§6)

- **Where**: in `bridge/direct-rpc-protocol.mjs` (shared by Bridge and App), around the existing
  compress-and-chunk step: `payload → deflate → AES-256-GCM(dataKey, nonce) → base64 → chunks`. One place
  covers `rpc` params, `rpc_result`, `push` and `stream` (`m` of terminal/preview frames).
- **Clear envelope**: `v`, `kind`, `method`/`event`, `requestId`/`id`, `sessionId`, `chunk`, `keyId`,
  `from`/`replyTo`. Everything else is ciphertext.
- **AAD**: `kind`, `method|event`, `requestId|id`, `sessionId`, `chunk.index` (and `turnId`, `seq` where
  the clear envelope has them), so the relay cannot move a ciphertext elsewhere.
- **Nonce**: random 12 bytes per encrypted payload. A payload is encrypted once before chunking, not per chunk.
- **Budget**: the signed frame limit (28 KiB) already leaves room; check `PACKED_MAX_CHARS` and RPC chunk
  sizes with the GCM tag + base64 overhead.
- **Failure**: a payload that fails to decrypt is dropped and counted; it never reaches handlers (this is
  also the defence against injected frames from another account, §12 item 8).
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

1. **Crypto core**: HKDF derivations, AES-GCM payload seal/open with AAD, wire it into
   `direct-rpc-protocol.mjs` behind a key (no key = today's behaviour); Node + browser; ≈15 lines of tests
   for round-trip, tamper and wrong-key.
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

## 10. Decisions needed

- **D1** Self-host: encryption on by default with `K` in the Setup QR, or keep self-host unencrypted?
- **D2** Web App: where to keep `K` (IndexedDB non-extractable `CryptoKey` + re-pair on loss), or no
  hosted web App at all?
- **D3** Old self-host Apps/Bridges: v2 already requires updating both; is a mixed encrypted/unencrypted
  window needed at all (proposal: no — one coordinated update, like stage 3)?
- **D4** Android notifications on hosted: FCM, a socket, or off (§13 item 8; polling costs ~170k
  requests/device/month).
- **D5** Reuse of `feat/device-credentials`: rebase its token model, or write the smaller version here?
- **D6** Recovery phrase shown in Settings by default, or only on request?
