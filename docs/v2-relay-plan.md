# v2 phase 4: hosted relay (profile B) — plan

Status: initial plan, 2026-11-15. Phase 4 of `docs/v2-architecture.md` §14 ("Profile B: resident relay sharing
the protocol core, CloudFront origin switch for the hosted service, monitoring and alarms"). Phases 1–3 are
merged into `feat/v2`: direct channel without DynamoDB session storage, accounts / pairing / device
management (PR #229, `docs/v2-accounts-design.md`), end-to-end encryption (PR #217,
`docs/v2-accounts-e2ee-plan.md`). This plan lists what phase 4 has to build, what earlier phases deferred to
it, and the decisions to take before code. Details are settled per PR, as before.

Note on history: `docs/terminal-relay-options.md` and the terminal benchmarks record (2026-09) that a
resident EC2/Fargate relay was ruled out. That decision still holds for **self-host** (profile A stays
API Gateway + Lambda). `docs/v2-architecture.md` §2 later introduced profile B **only for the shared hosted
service**, where API Gateway pricing and its per-connection authorisation limits (§12 item 8) do not work.

## 1. Goal and scope

- A public hosted service at `agentbaton.app` that many untrusted accounts can share: every frame is
  authorised and metered per account by the relay itself, and cost grows with bytes, not API Gateway messages.
- **Clients are unchanged in behaviour.** App and Bridge speak the same protocol to both profiles; only what the
  server announces differs (frame limit, whether signing credentials are needed). Moving the hosted service
  between profiles or machines is a CloudFront origin change (architecture §3).
- Profile A (self-host) keeps working exactly as today; profile B is a second deployment, not a replacement.
- Out of scope: store submission (phase 5), billing, email, the UX gaps of phase 6.

## 2. What profile A does today (the parts profile B replaces or keeps)

| Piece | Profile A today | Code |
|---|---|---|
| REST: version, install, accounts, pairing, devices, notifications | API Gateway REST + FastAPI Lambda, DynamoDB SystemTable | `server/src/{main,accounts,auth,bridge_read,notifications}.py` |
| Control socket (Bridge): connect, heartbeat, `bridge_join`, device rows, update pushes | WsApi + `ws-handler` Lambda, ConnectionsTable | `server/src/bridge_ws.py`, `direct_rpc_ws.py` |
| Data sockets (App `app_data`, Bridge `bridge_data`) | TerminalDirectApi; sender SigV4-signs each frame with STS credentials; `rpc`/`push` routes → HTTP integration → `@connections/{id}`; no Lambda per frame | `bridge/direct-rpc.mjs`, `web/js/v2/direct-transport.js`, `bridge/direct-rpc-protocol.mjs` |
| Frame format | `rpc`, `rpc_result`, `rpc_ack`, `push`, `stream`; deflate + E2EE seal + 20 000-char chunks under the 32 KB frame limit | `bridge/direct-rpc-protocol.mjs`, `bridge/e2ee*.mjs` |
| Subscriptions | Bridge's own table; App renews every 60 s (150 s lease) because API Gateway never tells Bridge an App left | `bridge/session-subscribers*`, `direct-transport.js` |
| Attachments | S3 `t/<accountId>/`, client-signed with the same STS credentials (session policy scoped to the prefix) | `bridge/transfer-store.mjs` |
| Notifications | Bridge decides and posts `/api/notifications/events`; iOS through the shared APNs relay; Android polls the feed | `bridge/notify.mjs`, `server/src/notifications.py`, `push-relay/` |
| Edge | CloudFront: default → REST, `/ws` → WsApi, `/data` → TerminalDirectApi; origin secret header for real client IPs | `server/template/Baton.template` |

## 3. Profile B architecture (proposal)

```text
App / Bridge ──TLS──► CloudFront (agentbaton.app)
                        ├─ default (REST)  ──► API Gateway + Lambda (unchanged, D1)
                        └─ /ws  (one socket per client) ──► EC2 t4g (Tokyo): Node relay
                                                               ├─ auth: token → account (SystemTable, cached briefly)
                                                               ├─ routing: accountId → {bridges, apps} in memory
                                                               ├─ forwards frames, never stores or decrypts them
                                                               └─ meters frames/bytes per account
DynamoDB SystemTable (accounts, tokens, pairing, push devices) and S3 attachments: shared with REST.
```

- **One Node process** on one Graviton instance in `ap-northeast-1` (start `t4g.micro`, architecture §3.2),
  systemd, EC2 auto-recovery, TLS at the origin (D3). Routing state lives in memory only and is rebuilt by
  client reconnects.
- **One socket per client** (App and Bridge) instead of control + data sockets: the relay authenticates the
  upgrade with the same `apiKey` credential (`bt_…` token or, for completeness, a deployment key) through the
  same rules as `server/src/auth.py`, including roles and the Bridge device-name binding.
- **Protocol core reused, transport swapped.** The frame codec, chunking, E2EE sealing, `rpc_ack`, streams and
  request/response logic stay (`direct-rpc-protocol.mjs`, `e2ee*.mjs` are plain JS and run in the relay too
  if needed). What profile B removes from the client path: STS credentials for frames, SigV4 signing,
  `rpc_join` tickets, the MOCK `whoami`, `realtime_ping` MOCK routes, the 32 KB chunk ceiling (announce a
  larger `maxFrameBytes`, verified through CloudFront first). Clients pick the transport from what the server
  announces (`/devices` already returns `protocol`, `rpc.endpoint`, credentials); profile A clients keep the
  current path.
- **Per-frame authorisation**: a frame may only reach a connection of the same account; `to` addresses are
  resolved by the relay (device name for Bridges, connection id for Apps), never trusted from the sender.
  This closes architecture §12 item 8 for the hosted service.
- **Disconnect events**: the relay tells a Bridge when an App connection goes away, so subscription leases,
  the 60 s renewal and `replaces` can be deleted for profile B (decision recorded in the step-3B plan "Later");
  profile A keeps them.

## 4. Work items

### 4.1 Relay core (new `relay/` package, MIT, same repository — architecture §15)
1. WebSocket server (`ws`, already a Bridge dependency) behind the TLS terminator; health endpoint.
2. Upgrade auth: token → `{accountId, kind, deviceName, tokenHash}` from SystemTable (short cache, plus an
   invalidation path so a revoke closes sockets at once; today `_close` deletes API Gateway connections).
3. In-memory routing tables, per-account; Bridge exclusivity per device name (today `bridgeOwner` /
   `bridge_replaced` in `bridge_ws.py`).
4. Frame forwarding with per-frame account check, `maxFrameBytes`, backpressure (drop or close a slow
   consumer above a buffer threshold), ping every ≤ 5 min (CloudFront idle timeout 10 min).
5. Server → client events that today come from Lambda: Bridge list changes (`bridges` update to Apps),
   `device_removed`, `account_rotated`, `account_deleted`, `bridge_replaced`, `heartbeat` answers with
   `bridgeVersion` (auto-update trigger).
6. Revocation and deletion hooks: REST (Lambda) must be able to close relay sockets of a token or an account
   (D2: relay admin endpoint authenticated by IAM/secret, or relay polls a revocation stream).
7. Graceful restart: announce reconnect within a random 0–10 s, then stop. Bridge reconnect today is
   immediate then a fixed `RECONNECT_DELAY` (`bridge/ws.mjs` `scheduleReconnect`) — add jitter; the App
   already jitters (`direct-transport.js`, `RETRY_JITTER_MS`).

### 4.2 Clients
8. Transport selection from the server's announcement; one code path for frames above the transport layer
   (`direct-transport.js`, `bridge/direct-rpc.mjs`). Keep profile A untouched behind the same interface.
9. Delete lease/renewal logic on profile B only (relay disconnect events).
10. Frame and envelope slimming where bytes are billed (step-3B plan "Traffic": push envelope duplication,
    terminal/preview frames) — measure first (architecture §13 item 1).

### 4.3 Abuse limits and metering
11. Per-account frames/bytes per minute and concurrent connections; per-IP connection rate at the relay
    (it sees the real address via CloudFront's viewer headers / origin secret); limits reported in logs and
    metrics, enforced by closing or throttling.
12. Keep the REST limits from PR #229 (register / recover / pair-start per IP, computers per account).

### 4.4 Edge, domain and deployment
13. CloudFormation (or a separate template) for profile B: EC2 + instance role (DynamoDB SystemTable read,
    CloudWatch), security group (origin reachable only from CloudFront — managed prefix list), EIP or DNS name.
14. CloudFront: `/ws` → EC2 origin, origin secret header, `Sec-WebSocket-*` forwarding, deflate check,
    custom domain `agentbaton.app` + ACM certificate (us-east-1).
15. **`WEB_URL`**: today `https://${CDN.DomainName}`; make it a parameter so pairing links printed by Bridge and
    returned by `pair/start`/`pair/create` use `https://agentbaton.app` (decided 2026-11-14 to do it here).
16. Dedicated AWS account for hosted production (architecture §12 item 7); production parameters stay outside
    the repository.
17. Monitoring and alarms: connections, frames/s, bytes, memory, CPU credits, error rate, restarts; alarm email
    (same pattern as the push relay); logs 7 days, never content, paths, titles, tokens or bodies.

### 4.5 Items earlier phases deferred to phase 4
18. **Hosted Android notifications (D4 of the accounts plan)**: FCM (new dependency, needs approval) vs a
    relay socket held by the existing Android foreground service vs off. Polling the feed every 5/15 s is not
    acceptable at hosted scale (~170k requests per device per month, architecture §8).
19. **Videos and attachments over 50 MB**: encrypt in chunked records with Range support (`SEALED_MAX`,
    `transfer-store.mjs`); videos stream today in plain form under the account prefix.
20. "Being viewed" suppression for notifications can move to the relay (it knows live subscriptions) instead
    of the Bridge's `notify_check` probe — optional, decide in design.

### 4.6 Validation before go-live (architecture §13)
21. Load test on `t4g.micro`: idle connections per GB, sustained frames/s, CPU credits; reconnect storm after a
    restart (jitter works).
22. CloudFront WebSocket facts: request counting for upgrades, largest frame that passes, deflate end to end,
    idle behaviour with the ping interval.
23. Cross-account isolation suite run against **both** profiles (architecture §14 item 2); the existing
    `test/server/test_accounts.py` covers REST; add relay frame-routing tests.
24. Reachability from mainland China mobile networks (no CloudFront edge there).
25. Cost check against architecture §11 with measured traffic.

## 5. Decisions to take (proposals in brackets)

- **D1 REST stays on API Gateway + Lambda in profile B** [yes: REST traffic is small; only the real-time path
  moves to EC2; SystemTable and code stay shared]. Alternative: run the FastAPI app on the EC2 too.
- **D2 How REST tells the relay to close sockets** (revoke, remove, delete, rotate notices) [a small authenticated
  admin endpoint on the relay, called by Lambda; relay re-checks the token on every reconnect anyway].
- **D3 TLS at the origin** [Caddy with automatic certificates on an origin hostname, origin locked to the
  CloudFront prefix list] vs an ALB (simpler certificates, ~$16+/month).
- **D4 Instance size and region** [`t4g.micro`, `ap-northeast-1`, vertical scaling first].
- **D5 Hosted Android notifications** [relay socket in the foreground service if battery is acceptable;
  FCM only with approval].
- **D6 Frame size in profile B** [`maxFrameBytes` 512 KB after verification; fewer chunks, same codec].
- **D7 One socket per client in profile B** [yes] and keep profile A's two sockets.
- **D8 Relay language / packaging** [Node 22, `ws`, no new dependency beyond what Bridge already uses].

## 6. Suggested PR order

1. Relay core + local tests (routing, per-frame authorisation, auth, revocation hook), no deployment.
2. Client transport selection + lease removal for profile B; profile A regression suites unchanged.
3. Profile B deployment (template, CloudFront `/ws` origin, domain + `WEB_URL`, monitoring/alarms) on a test
   account, load test and CloudFront checks.
4. Abuse limits and metering; Android notifications (D5); large-attachment/video encryption.
Each PR: design details first → user OK → implement → self-test → PR → independent review (reproducible
findings only) → fix + re-review → acceptance on a separate test stack and test boxes → report → merge on OK →
delete test resources.
