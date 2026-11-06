# v2 Phase 1, Step 1: Home Page Served Directly by Each Bridge

Status: implemented and verified on the `BatonV2` test stack (2026-11-06), PR #177 into `feat/v2`.
Context: `docs/v2-architecture.md` §3–§5, §9, §14. Offline spikes live in the untracked `.scratch/v2-spike/`.

## Scope

- The home page (devices, Active, recent projects) is answered by each Bridge; nothing on it is read
  from the DynamoDB session rows or device aggregates.
- App ⇄ Bridge uses one `app_data` socket with direct delivery in both directions: requests and
  replies go through the API Gateway HTTP integration, so no Lambda runs per request.
- The app speaks only v2. A server whose `/devices` has no `protocol: 2` keeps the cached home and
  shows an update message.
- Recent projects: the 5 most recent projects (15 when expanded), each with its 5 newest root sessions.
- Unchanged in this step: lists and Session detail (still v1 REST), DynamoDB writes, the Bridge's
  startup full scan, `checkStopped` (which still reads `/active-sessions`). Step 2 removes them.

## Request flow

```
App opens (cached home shown at once)
 ├─ GET /api/bridge/devices                      → names, online, rpc { endpoint, credentials, bridges }
 └─ connect wss://<server host>/data?role=app_data, send whoami (MOCK route) → { connectionId }
 With cached routes the home request leaves right after whoami; otherwise after /devices.
 Per online Bridge: signed frame { v:2, kind:'rpc', method:'home', params:{revision}, replyTo } on the
 App socket → HTTP integration → Bridge socket. The Bridge answers the same way to replyTo.
 Each device waits at most 6 s; offline or late devices use their cached answer; then merge and render.
```

`/devices` response:

```
{ protocol: 2,
  devices: [{ deviceName, deviceDisplayName, os, online }],
  rpc: { endpoint, credentials, bridges: [{ device, dataId }] } }
```

- `endpoint` is the execute-api host of the data API. SigV4 must sign that host, and it cannot be
  derived from the CloudFront domain. The region is parsed from it.
- `credentials` are STS credentials (1 h, cached per account in the Lambda) allowing
  `POST @connections/*` on the data API only. API Gateway authorizes `@connections` against the route
  template `@connections/{connectionId}`, so per-connection ARNs always deny; the scope matches the
  credentials the Bridge already receives from realtime `hello`.
- `bridges` lists only Bridges whose `bridge_data` socket has joined, which implies a v2 Bridge.

## Transport (`web/js/v2/direct-transport.js`)

Callers use only `request(device, method, params)`. Everything else is internal:

- One socket for the App's lifetime; rebuilt (with a new `whoami`) after a drop. Pings every 60 s while
  visible because CloudFront closes idle WebSockets after 10 minutes.
- Routes `{ online, dataId, version }` come from the cached `rpc`, then `/devices`, then
  `bridges_changed` pushes; a changed route bumps `version`.
- `reconcile()` runs on every event (whoami, route update, reply, 250 ms tick) and, per pending request:
  offline → reject; 6 s after the first send → reject; route version changed → resend; 2 s without a
  reply → retry once. Every send uses a new `requestId`; the first reply wins.
- Stale cached credentials or addresses need no special case: the send fails silently and the
  `/devices` answer, or a `bridges_changed` push after a Bridge reconnect, triggers the resend.

## Server

- `bridge_read.py`: `/devices` returns only the fields above (one connections query, no activity
  index query). `/config` is unchanged (`wsUrl` for the Bridge).
- `direct_rpc_ws.py` (new):
  - `bridge_token` (Bridge control socket) → one-time token, 60 s.
  - `bridge_join` (`bridge_data` socket) → checks token, expiry, account and that the control
    connection is the device's current one; stores `rpcDataId`; pushes `bridges_changed` with fresh
    credentials to the account's `app_data` sockets. Disconnects push again.
- `bridge_ws.py`: `app_data` / `bridge_data` roles are allowed on the data API only; `direct_rpc`
  dispatch; disconnect cleanup.
- Template: CloudFront `/ws` and `/data` behaviours (function rewrites the path to `/v1`), REST origin
  keep-alive 60 s, MOCK `whoami` route on the data API, ws-handler 512 MB, REST role may assume the
  direct role. New Python modules must also be added to `server/src/Dockerfile` and the WS zip list
  in `install.sh`; Bridge modules imported by the web app go into the build context in `install.sh`.

## Bridge

- `home-index.mjs` (new): on-demand answer without a full scan.
  - Index: stat every Claude JSONL (mtime = lastActive) and read the first 8 KB of each Codex rollout
    (`cwd` → project, `parent_thread_id` / `forked_from_id` → child).
  - In-memory caches: Codex headers, previews and validity per file, Claude subagents, process info
    (5 s), project names. A preview changes only with a title or first prompt, which the watchers
    report through `noteClaude` / `noteCodex`; plain appends only refresh the stat.
  - Status: `lastKnownStatus` first (pool, watchers, `checkStopped`, agent poll), else computed for
    candidates only (live process, daemon agent, Claude file within 5 min, Codex within 15 min, fresh
    subagent). Agents come from the poll's cache, never from a synchronous `claude agents --json`.
  - Changes only mark the answer dirty; a request rebuilds it (~5 ms, at least every 15 s for the time windows) and bumps
    `revision = <boot id>.<n>`, so an equal revision yields `notModified`.
  - Warmed in slices after startup; no periodic rescan (watchers plus rebuild on restart, as in v1).
- `direct-rpc.mjs` (new): `bridge_token` → `bridge_data` socket on the credentials' endpoint →
  `bridge_join`; reconnects with jitter; serves `home` and `ping`, at most 4 at a time.
- `direct-rpc-protocol.mjs` (new, shared with the web app): request and result frames, raw deflate +
  base64 above 1 KB when the requester accepts it, chunks of 20 000 (base64) or 6 000 (JSON) characters,
  reassembly in any order. The browser inflates with `DecompressionStream('deflate-raw')`; without it
  the App does not ask for deflate.
- Hooks: watchers call the index, `lastKnownStatus` is an `ObservedMap`, deletions rebuild the index,
  `bridge.mjs` starts the warm-up.

Home answer (field names as in v1):

```
{ revision, notModified?,
  device: { projectCount, runningCount, needsInputCount, lastActive },
  sessions: [ { sessionId, preview, status, lastActive, agentCount, projectHash, projectName, isAgent?, agentName?, agentDetail? } ],
  recentProjects: [ { projectHash, projectName, lastActive, sessions: [ …≤5 ] } …≤15 ] }
```

`sessions` holds every active root (`running`, and `needs_input` from the last 7 days). Previews keep
the Bridge's existing 200-character limit. The App adds `deviceName`.

## Web

- `api.js` routes `/api/bridge/active-sessions` and `/api/bridge/devices` to `loadHomeV2()`; the home
  preload in `index.html` goes through `api.js` once it has loaded. Rendering is unchanged.
- `home.js`: asks cached online Bridges at once, updates the device rows when `/devices` answers
  (`window.__renderHomeDevices`), asks newly online Bridges, then merges: active sessions of online
  devices by time, recent projects of all answers (cached for offline or late devices) by time, first 15.
- Device rows without any answer show only name and state (no project count or time).
- `window.__v2Timings` records `/devices`, connect, `whoami`, per-device round trips and the total.

## Results (medians, `BatonV2`, Bridge on `test-ec2-ap` in Tokyo)

| | Tokyo | US East |
|---|---|---|
| Home request round trip | 45–56 ms | ~200 ms |
| First screen, cached routes | 0.10–0.13 s | ~0.92 s |
| First screen, first install | ~0.17 s | ~0.97 s |
| Previous Lambda-forwarded path | 401 ms | 721 ms |

- The live Bridge answer equals a full local discovery field by field; active sessions and device
  counts equal the v1 REST answer on the same stack.
- Bridge warm-up 524 ms (83 files); on a 3264-file machine the on-demand answer takes ~1.1 s cold and
  ~0.16 s cached, against 8.9 s for the full scan. The home answer is ~4 KB compressed, one frame.
- Offline device: cache within 0.6 s. Frozen Bridge: retry at 2 s, cache at 6 s. Bridge restart:
  reachable again ~2 s later.
- CloudFront: through a cold edge pool a REST request pays a new origin handshake (+~300 ms from the
  US, ~35 ms from Tokyo); the 60 s keep-alive helps only when requests are close together. The first
  screen with cached routes does not wait for `/devices`. Origin Shield was not enabled: it does not
  suit uncacheable requests.

Known limitation: a sleeping laptop stays online for up to one heartbeat (~4 min), so the home waits the full 6 s for it, then shows its cache.

## Phase 2 consequences

- App credentials cannot be limited to the account's own sockets, so they are acceptable only for
  single-tenant self-hosting. Multi-tenant isolation (architecture §12.8) needs another mechanism:
  receiver-verified frame signatures, the EC2 relay for the hosted service, or Lambda forwarding.
- With the EC2 relay (profile B) the credentials, `whoami` and routes disappear; the request API, frame
  format, chunking, compression, `revision`, `home-index` and the App merge stay the same.
