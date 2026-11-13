# v2 PR B: accounts, QR pairing, device management, multi-tenancy — technical design

Status: design, 2026-11-13. Implements items 1–9 of PR B in `docs/v2-accounts-e2ee-plan.md` §9 (decisions
in §10, pairing in §5, multi-tenancy checklist in §7). PR A (end-to-end encryption, #217) is merged into
feat/v2 (3fd9d92c); everything here builds on `bridge/e2ee.mjs` / `e2ee-node.mjs` and its sessions.
Budget: about 1,100 lines including tests (§13).

## 1. Principles

- **One credential slot.** App and Bridge already send a secret as `apiKey` (WebSocket query) and
  `x-api-key` (REST). That slot now carries either the deployment API key (self-host, unchanged) or a
  device token. No client request format changes; only what is stored there changes.
- **The server resolves the account once per request** from that credential and never from a body field.
- **The server never sees `K`.** It stores `accountId`, `hash(joinSecret)`, token hashes and sealed blobs
  it cannot open.
- **Self-host keeps working as today.** The API key still authenticates everything; registration of new
  accounts is off unless the stack enables it (`OpenRegistration`, §12).
- Lean: reuse PR A's derivations and transports, SystemTable, the existing install script and Setup page.

## 2. Credentials and the resolver

Token format: `bt_` + 32 random bytes base64url (46 chars). Stored only as `sha256(token)` hex.

`server/src/auth.py` (new, replaces the account part of `api_key.py`):
- `resolve(credential) -> {accountId, kind, deviceName, tokenHash} | None`
  - deployment API key (constant-time compare, as `api_key.is_current`) → `{accountId: pinned/legacy id, kind: 'key'}`;
  - `bt_…` → `TOKEN#<hash>` row, then the account's `META` row must exist (deleted or expired accounts fail);
  - results cached in-process 60 s (like `feat/device-credentials`' `resolve()`); `lastSeen` written at most hourly.
- `forget(tokenHash)` drops cache entries on revoke/delete.

Call sites switched to `auth.resolve` (all five that use `api_key.account_id` / `is_current` today):
`bridge_read.py:_account_id`, `notifications.py:_account`, `bridge_ws.py:_handle_connect` (and
`_account_id`), `direct_rpc_ws` callers that receive `accountId` from the connection row (unchanged).

REST enforcement: `ApiProxyMethod.ApiKeyRequired` becomes `false` (`server/template/Baton.template:174`);
a FastAPI middleware on `/api/*` rejects with 401 when `auth.resolve` fails and stores the result on
`request.state.auth`. `/api/version`, `/api/account/register`, `/api/account/recover`, `/api/pair/claim`,
`/api/pair/start`, `/api/pair/wait` are public (they are their own authentication). Coarse abuse protection:
WebSocket stage throttling (rate 200 / burst 400) and the API Lambda's reserved concurrency (10). The REST
stage has no throttle: per-path settings cannot target the `ANY` proxy method, and a stage-wide one would also
throttle the static site, which goes through the same Lambda. The usage plan and API key resource stay (self-host key).

WebSocket `$connect`: `apiKey` query parameter resolved the same way; a revoked token is refused with 401.

STS credentials (`issue_credentials`) are only issued to resolved credentials (already the case: issued from
the connection row, which is only written for a resolved account). On revoke the server deletes that token's
connections (`apigatewaymanagementapi.delete_connection`), so renewal stops.

## 3. Data (SystemTable, `pk` / `sk`, TTL attribute `ttl`)

| pk | sk | Attributes | TTL |
|---|---|---|---|
| `ACCOUNT#<accountId>` | `META` | `joinSecretHash`, `createdAt` | — |
| `ACCOUNT#<accountId>` | `TOKEN#<hash>` | `kind` (`app`/`bridge`), `deviceName`, `createdAt`, `lastSeen` | — |
| `TOKEN#<hash>` | `-` | `accountId`, `kind`, `deviceName` | — |
| `PAIR#<sha256(code)>` | `-` | `kind` (`app`/`bridge`), `accountId` (set when issued by a signed-in device or approved), `sealed` (K under `t`), `pollHash` (joining computer), `deviceName`, `token` (issued token for a waiting Bridge, deleted on read) | 10 min |
| `PUSH_DEVICE#<accountId>` | `<environment>:<token>` | (replaces the shared `PUSH_DEVICE` partition) | 30 days (as today) |
| `RATE#<scope>` | `<window start>` | `n` (atomic `ADD`) | window + 1 h |

Token rows are written in one `TransactWriteItems` with their account index row. Listing an account's
devices queries `pk = ACCOUNT#<id>, begins_with(sk, 'TOKEN#')`.

## 4. Endpoints (all JSON, all under the API's CloudFront origin)

| Route | Credential | Body → reply | Notes |
|---|---|---|---|
| `POST /api/account/register` | none | `{accountId, joinSecret, deviceName}` → `{token}` (app) | called by the first App, which creates `K`; only with `OpenRegistration`; `accountId` must not exist (conditional put); `RATE#ip` ≤ 5 / hour; `accountId == HKDF(K)` is unverifiable by the server and need not be |
| `POST /api/account/recover` | none | `{accountId, joinSecret, deviceName}` → `{token}` (app) | `hash(joinSecret)` must match; `RATE#ip` and `RATE#account` ≤ 5 / hour; pushes `account_recovered` to the account's Apps |
| `POST /api/account/rotate` | app token | `{joinSecret}` (new) → `{}` | after a device removal (§8) |
| `POST /api/account/delete` | app token | `{}` → `{}` | §9 |
| `POST /api/pair/create` | app token or API key or bridge token | `{kind:'app', sealed}` → `{code, expiresIn}` | sealed = K under `t` (§5) |
| `POST /api/pair/claim` | none | `{code, deviceName}` → `{token, accountId, sealed}` | atomic delete of the PAIR row (`ReturnValues: ALL_OLD`) |
| `POST /api/pair/start` | none | `{deviceName}` → `{code, poll}` | joining computer; `RATE#ip` ≤ 10 / hour |
| `POST /api/pair/approve` | app token | `{code, sealed}` → `{}` | binds the PAIR row to the App's account; refuses when the account already has 3 Bridges (free tier, §10); API-key Apps may approve too (self-host) |
| `POST /api/pair/wait` | none | `{code, poll}` → `{token, accountId, sealed}` or `{pending:true}` | long-poll up to 20 s; `poll` checked by hash; row deleted once read |
| `GET /api/bridge/devices` | any | existing reply + `apps: [{id, deviceName, kind, lastSeen}]` | `id` = first 12 hex of the token hash |
| `POST /api/tokens/revoke` | app token or API key | `{id}` → `{}` | deletes both token rows, closes its sockets, `forget()`; Bridge tokens also get `device_removed` (existing uninstall path) |

`/api/auth/start-token`, `/auth/exchange-token`, `/auth/install` stay for self-host Setup links (API key).

## 5. Pairing (plan §5)

QR / link payload: `https://<server>/pair#c=<code>&t=<t>`, `code` = 16 random bytes base64url, `t` = 16
random bytes base64url. The fragment never reaches a server.

Sealing (`bridge/e2ee.mjs`, browser; `e2ee-node.mjs`, Bridge): `pairKey = HKDF(t, info 'pair')`,
`sealed = base64(nonce ‖ AES-GCM(pairKey, K, AAD = code))`. Opening checks the AAD, then `deriveAccount(K)
.accountId === reply.accountId`; a mismatch aborts (the server lied).

The account is created by the first App that scans, never by a computer: an account therefore always has
a phone (no empty accounts to expire), and every computer and phone of one person ends up in the same account.

1. **Any new computer.** The install command (hosted: public `curl -sL https://<server>/install | bash`, §6)
   starts Bridge with no credential and no `K`. Bridge calls `pair/start`, prints `…/pair#j=<code>&t=<t>` as a QR
   code (+ link) **only when stdout is a TTY** (the installer runs `node bridge.mjs pair --once` in the
   foreground), and waits (`pair/wait`, a new code every 10 minutes while the terminal is open).
2. **An App scans a join code** (existing barcode-scanner plugin; web: paste the link):
   - signed in → seals its `K` under `t`, calls `approve`;
   - not signed in → creates `K`, derives `accountId`/`joinSecret`, calls `register` (App token), then
     `approve`.
   The waiting Bridge receives its token and sealed `K`, opens and checks it, saves `{apiKey: token,
   accountKey: K, accountKeyAt, accounts: true}` in `config.json` (0600), prints "Joined, approved by <App
   name>" and starts. No confirmation dialog (decided).
3. **Another phone / App.** A signed-in native App ("Add device") or a Bridge with `K` (`bridge.mjs pair`)
   creates an App code (`pair/create`, QR `…/pair#c=<code>&t=<t>`). The new App scans or opens it; `claim` →
   token + sealed; opens `K`; stores token as `_ak`, server as `_as`, `K` (§7). It sees every computer of the
   account at once (`/devices` is per account).
4. **Show a code again:** `node ~/.baton-bridge/bridge.mjs pair` (Bridge with `K`: App code; without: join
   code). `pair --join` makes a Bridge leave its account and show a join code (moving a computer to another
   account). The install script prints these lines.
5. **Recovery** (§9 of the plan): 24 words → `K` → `accountId`, `joinSecret` → `recover` → App token.
- In hosted mode the clear `account_key` method (PR A migration) is refused by Bridge: `config.accounts`
  is set when the Bridge joined; self-host keeps PR A's migration.

## 6. Bridge changes

- `bridge/accounts.mjs` (new): `createAppCode()`, `join()` (start/wait), `printQr(url)`
  (`qrcode-terminal@0.12.0`, approved; `small: true`), all small functions over `fetch`.
- `bridge/bridge.mjs`: `pair` subcommand (`--once`, `--join`) and the first-start branch (no `apiKey` +
  `--server` given → join); the install script passes `--server`.
- `server/src/bridge_read.py` `install_script`: a public `/install` route (only with `OpenRegistration`)
  that installs without a key; the existing keyed script is unchanged.
- `bridge/direct-rpc.mjs`: refuse clear `account_key` when `config.accounts`; new sealed method
  `account_key_rotate {k}` (from an App session only) and `account_key_sync` (§8).
- `bridge/notify.mjs` unchanged (already sealed); `bridge/ws.mjs` handles `account_deleted` like
  `device_removed`.

## 7. App changes

- **First run** (`web/landing.html`, `entry-landing.js`): three actions — "Scan the QR code on your computer"
  (native: barcode scanner; web: paste link), "Paste a link", "Use my own server" (today's key form). A
  `/pair#…` link opens landing: `c=` claims, `j=` registers a new account and approves (§5).
- **K storage** (`web/js/v2/account-key.js`): browser as today (non-extractable); native apps
  (`window.__TAURI_INTERNALS__`) also keep the raw bytes in the same IndexedDB record (needed to show a
  pairing code and the recovery phrase, decision D2). `appKeys()` unchanged.
- **Settings → Devices** (`web/setup.html`, `entry-setup.js`, already lists devices): computers and Apps
  from `/devices` (`apps`), "Remove" per row (§8); "Add device" shows a QR (`qrcode-generator`, already a
  dependency) from `pair/create`; "Add computer" scans a join QR (native only).
- **Recovery phrase**: "Show recovery phrase" (native only, after confirmation) and "Recover account" on
  landing. BIP-39 English word list as data in `web/js/v2/words.js` (2,048 words, public domain; not code).
  Encoding: 256-bit `K` + 8-bit checksum (first byte of SHA-256) = 24 × 11 bits (standard BIP-39).
- **Delete account** (Settings, confirmation): §9.

## 8. Device removal and key rotation

Removing an App or a computer (Settings, any App; a browser App holds `K'` raw only until it is sent, then
stores it non-extractable). Self-host (`config.accounts` unset): step 1 only — devices signed in with the API
key have no token, and PR A's migration would undo a rotation; the API-key holder controls every device anyway (D1).
1. `POST /api/tokens/revoke {id}` — the server deletes the token, closes its sockets, sends
   `device_removed` to a removed Bridge. From now on the removed device cannot reach the account.
2. The App creates `K'` (random), computes `joinSecret'`, calls `POST /api/account/rotate`.
3. It sends `account_key_rotate {k: K'}` sealed over its session to every online Bridge. A Bridge saves
   `K'` (`accountKeyAt` now), keeps `previousKey = K` for 7 days, and joins again with new keys.
4. Other Apps and Bridges offline at that moment: on their next connection they hold the old `K`. A Bridge
   that still has `previousKey` accepts sessions under the old `psk` **only** for `account_key_sync`, which
   returns `K'` sealed in that session; the App then derives new sessions. An offline Bridge gets `K'` from
   the next App that sees its old fingerprint (the App sends `account_key_rotate` to it over a session
   derived with its own `previousKey`, kept 7 days like Bridge's).
- Security note (documented trade-off): within those 7 days, a removed device that still has the old `K`
  could fetch `K'` through `account_key_sync` only if the relay lets it reach a Bridge; the server refuses
  its token, so this needs the relay itself to collude. A per-device key pair would remove this window at
  the cost of a public-key directory; not in v2.0.
- The recovery phrase changes with `K'`; Settings says so after a removal.

## 9. Account deletion

`POST /api/account/delete` (App token, confirmation in the App): deletes `ACCOUNT#` META and token rows,
`TOKEN#` rows, `PUSH_DEVICE#<id>`, `NOTIFICATIONS#<id>`, `DEVICE#<id>/…` rows and closes every socket of the
account; Bridges get `account_deleted` (handled like `device_removed`: remove service and config, exit).
Files in `t/<accountId>/` expire with the 7-day lifecycle. The App clears `K` and local data and returns to
landing.

## 10. Multi-tenancy hardening (plan §7 / architecture §12)

1. Every route uses `request.state.auth.accountId`; the five call sites in §2 are the only resolution points.
2. Push devices move to `PUSH_DEVICE#<accountId>` (`notifications.py` `PushDevice.key`, `post_event` query,
   relay cleanup); existing shared rows are ignored (Apps re-register on every launch).
3. Lambda log groups: `install.sh` sets 7-day retention (`aws logs put-retention-policy`) on both Lambda log
   groups after each deploy (a template `AWS::Logs::LogGroup` would collide with the existing groups).
4. Limits (`RATE#` rows, atomic `ADD` with condition): register 5 / hour / IP, recover 5 / hour / IP and
   / account, pair/start 10 / hour / IP; at most 3 Bridge tokens per account (`approve`); stage throttling (§2).
5. No empty accounts: an account is created by an App (§5), so there is no expiry; the resolver rejects
   tokens whose META row is gone (deleted account).
6. Logged payloads: none (request bodies are never logged today; keep it so).

## 11. Cross-account test suite

`test/server/test_accounts.py` (pytest, fake SystemTable/Connections like `test_direct_rpc.py`), two
accounts A and B, asserting B's credential can never:
- read A's devices, notification events or push devices; revoke A's tokens; claim, approve or wait on A's
  pairing code with the wrong `poll`; connect after its token is revoked; recover with a wrong joinSecret;
  register an existing `accountId`; exceed the limits in §10.4.
Plus a live acceptance script (not in CI) on a two-account test stack: STS S3 prefix 403 across accounts
(already true), sealed frames from B's App to A's Bridge are dropped (PR A), and every route above.

## 12. Compatibility and rollout

- Stack parameter `OpenRegistration` (default `false`): self-host stacks keep API-key-only behaviour plus
  pairing from signed-in devices (an API-key App may create pairing codes for new phones). Hosted test
  stacks set it to `true`.
- Existing self-host users: nothing changes; tokens are additive. PR A's migration stays the K path for them.
- Deploy order: server first (resolver accepts both), then App/Bridge; one coordinated release (D3).

## 13. Line budget (estimate, code + tests)

| Area | Files | Lines |
|---|---|---|
| Resolver, middleware, call sites, template/stage throttling | `auth.py` (new), `main.py`, `bridge_read.py`, `bridge_ws.py`, `notifications.py`, `Baton.template` | 170 |
| Account and pairing routes | `accounts.py` (new), `main.py` | 110 |
| Bridge join/pair/QR, hosted `account_key` refusal, rotate/sync | `accounts.mjs` (new), `bridge.mjs`, `direct-rpc.mjs`, `ws.mjs`, `config.mjs`, `install_script` | 160 |
| App first run, claim, K storage, Add device / computer | `entry-landing.js`, `landing.html`, `account-key.js`, `entry-setup.js`, `setup.html` | 250 |
| Removal + rotation (server, Bridge, App) | `accounts.py`, `direct-rpc.mjs`, `direct-transport.js`, `entry-setup.js` | 150 |
| Recovery phrase (encode/decode, UI) | `recovery.js` (new) + `words.js` (data) | 70 |
| Account deletion | `accounts.py`, `ws.mjs`, `entry-setup.js` | 60 |
| Multi-tenancy hardening | `notifications.py`, `install.sh`, `accounts.py` | 90 |
| Cross-account tests | `test_accounts.py` | 80 |
| **Total** | | **≈ 1,140** |

## 14. Work order (commits inside PR B) and acceptance

1. Resolver + middleware + template (server only; API key behaviour unchanged) — tests.
2. Account + pairing routes, PUSH_DEVICE#, limits, log retention — `test_accounts.py`.
3. Bridge join/pair/QR + public `/install`.
4. App first run (claim, register + approve) + K storage + Add device / computer.
5. Removal + rotation; recovery phrase; account deletion.
Acceptance on a separate test stack (`OpenRegistration=true`) and a fresh EC2 test box, as for PR A: two
accounts, both pairing directions, revoke + rotation with one App offline, recovery on a fresh browser
profile, account deletion, cross-account script, Device Farm Android run (pair by scanning is replaced by
opening the `/pair#…` link). Delete the test stack and box afterwards.

## 15. Out of scope

EC2 relay (phase 4), per-token request-rate limiting beyond stage throttling, email, billing, iOS/Android
store submission, per-device key pairs (§8 trade-off), hosted Android FCM (D4).
