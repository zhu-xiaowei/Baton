# v2 phase 4: hosted service on Cloudflare, one JS server for both platforms — plan

Status: plan, revised 2026-11-16 (first version 2026-11-15 proposed an EC2 relay; replaced after the cost and
latency measurements in §3). Phase 4 of `docs/v2-architecture.md` §14. Phases 1–3 are merged into `feat/v2`:
direct channel without DynamoDB session storage, accounts / pairing / device management (PR #229,
`docs/v2-accounts-design.md`), end-to-end encryption (PR #217, `docs/v2-accounts-e2ee-plan.md`).
Details are settled per PR and recorded in §8 as they are decided.

## 1. Decisions (user, 2026-11-16)

| # | Decision |
|---|---|
| 1 | The shared hosted service (`agentbaton.app`) runs on **Cloudflare**: Workers + Durable Objects (one object per account, relay and account storage) + R2. **No EC2.** Self-host keeps AWS (profile A). |
| 2 | **One server codebase in JavaScript** with two platform adapters (AWS, Cloudflare). The Python/FastAPI server is rewritten; the earlier constraint "profile A stays unchanged" is lifted. DynamoDB schema, REST routes and the client protocol stay the same, so existing self-host stacks, Apps and Bridges are unaffected. |
| 3 | App and Bridge speak one protocol to both platforms; what differs is announced by the server (transport, frame limit, file storage). |
| 4 | Order: platform-independent protocol optimizations first, then the JS rewrite (AWS adapter), then the Cloudflare adapter, then client transport selection, then launch items (§6). |
| 5 | Each platform deploys with one command. AWS keeps its current pipeline (Docker + CodeBuild + ECR); Cloudflare gets an install script with the same experience (§5). No new third-party dependencies (Cloudflare deploys through its HTTP API, no wrangler). |
| D1 | REST keeps being served by the server functions (Lambda / Worker); no separate REST host. |
| D7 | One socket per client on Cloudflare; profile A keeps its control + data sockets. |
| — | Workers KV is not used: eventually consistent (≥ 60 s), no atomic or conditional writes, which revocation, single-use pairing codes, removal transactions and rate counters need. |
| — | Python Workers are not used: Pyodide (WebAssembly) costs more CPU per frame, needs pywrangler + uv, and would share little with the AWS code. |

## 2. Why not EC2 (superseded proposal)

EC2 + CloudFront costs about $12.5/month before the first user (t4g.micro + IPv4 + disk), bills bytes
(CloudFront to origin $0.06/GB in Japan), needs origin TLS certificates, an Auto Scaling group / Elastic IP for
machine replacement, and operating a machine. A plain-HTTP origin would expose bearer tokens between
CloudFront and EC2. Durable Objects need none of this, cost less at every scale measured (§3), and have no
machine to migrate; connections on the Hibernation API survive Worker code updates.

## 3. Measurements (2026-11-16)

Spike: `.scratch/do-spike/` (Worker `relay-spike` + SQLite-backed DO on the Free plan, deployed by API).
Replayed the phase-1 recordings (`agentpeek-v2-core/.scratch/phase1-validation/traffic/`: chat, terminal,
history; real timing and body sizes without SigV4), 10 accounts × (Bridge + App).

| Metric | Result |
|---|---|
| Frames | 12,640 sent, 12,640 received (per-frame IDs) |
| Billed active time per frame | 0.23 ms (2.9 × 10⁻⁵ GB-s); CPU 0.10 ms |
| Idle hibernated sockets, auto-response ping every 25 s | ≈ 0 billed |
| Cost per million frames | ≈ $0.008 (API Gateway: ≈ $2.28 — every frame billed in and out) |
| Typical / heavy user per month | ≈ $0.0006 / ≈ $0.005 (relay only) |
| Latency, Tokyo host, object in Japan | one-way p50 8–9 ms, p95 11–12 ms; ping RTT 8–9 ms |
| Latency, object in US west from Tokyo | one-way p50 114 ms (objects never move) |
| New connection (TLS + first object creation) | 280–360 ms |
| Reference: profile A direct path from Tokyo EC2 | round trip p50 21–35 ms (`docs/terminal-relay-options.md`) |

Monthly estimates (relay only; REST, notifications and storage add about $250 at 100k DAU on either platform):

| Scale | Cloudflare DO | Profile A (API Gateway) | EC2 + CloudFront (dropped) |
|---|---|---|---|
| ≤ ~600 DAU | $0 (Free plan) or $5 | ~$0.25–1.65 per user | ~$12.5 + |
| 10k users | ~$10 | ~$2.5k | ~$28–56 |
| 100k DAU | ~$160 | ~$50k | ~$600–750 (flat-rate plan) |
| 1M DAU | ~$1.5k | ~$500k | ~$5–8k |

Cost on Durable Objects follows the **number of incoming messages** (20 messages = 1 request, $0.15 per
million requests); bytes and egress are free. DO placement (apac, 2026-11-16): Singapore 40%, Hong Kong 20%,
Narita 17%, Osaka 16%, Seoul 7%; hints wnam/enam/weur/eeur/apac(-ne/-se)/oc; jurisdictions eu/us/fedramp.

Not yet measured: mainland China reachability, idle sockets without pings, account-storage latency, reconnect
storms, many sockets per object, R2 checksum/Range behaviour.

## 4. Target architecture

```text
server/core/        shared: routes, auth and rules (accounts, pairing, tokens, devices, notifications,
                    install scripts, version) on web-standard Request/Response; depends only on a ports
                    object: store, sockets, files, push
server/aws/         Lambda (Node 22) entries (REST + control socket); DynamoDB store (SystemTable, same
                    schema); API Gateway @connections; S3 + STS credentials; Dockerfile
server/cloudflare/  Worker entry; Durable Object per account = relay + SQLite store; global index
                    (pairing codes, recovery, rate limits); R2; install.sh
server/install.sh, server/template/   stay where they are (the documented AWS one-line command uses them)
test/contract/      one suite, run by URL against any deployment
```

- The platforms differ in four ports only: store, sockets, files, push. Rules live in `core` once.
- Protocol, E2EE and SigV4 code stays in `bridge/` (the Bridge package needs it); the server imports it.

- AWS calls use `fetch` + the SigV4 code the repository already has (`bridge/direct-rpc-protocol.mjs`,
  `bridge/transfer-store.mjs`), so neither platform needs aws-sdk or a web framework.
- Cloudflare per-account object: holds that account's sockets and rows (account, devices, tokens, push
  devices), so revocation closes sockets in the same call — the EC2 plan's "revocation hook" disappears.
  Tokens carry the account ID so the Worker routes to the object without a global token table.
- Relay on Cloudflare: Worker authenticates the upgrade, forwards to the account object; the object relays
  frames only between that account's sockets (isolation by construction), sends disconnect events, answers
  pings by auto-response. The Bridge connects first and creates the object near itself.
- Files: R2 through the S3 API with prefix-scoped temporary credentials if R2 checks
  `x-amz-checksum-sha256` and Range like S3; otherwise presigned URLs from the Worker.
- iOS pushes keep the shared APNs relay (`push-relay/`, IAM-auth Function URL); the Worker signs with SigV4.
- One cross-platform contract suite (account isolation, pairing, revocation, removal) runs against both
  adapters; the Python tests are deleted with the Python server.

## 5. Deployment

- **AWS: unchanged pipeline** (user, 2026-11-16: it is already the simplest for users). `curl … install.sh |
  bash` (or `./install.sh` from a clone) → Docker image built by CodeBuild → ECR → Lambda → CloudFormation →
  prints the Start URL and QR code. Only the image changes: Node 22 base instead of Python + Lambda Web Adapter;
  the Vite build stage stays.
- **Cloudflare: the same experience, one script.** Proposal:
  ```
  curl -fsSL https://raw.githubusercontent.com/agentbaton/baton/main/server/cloudflare/install.sh | bash
  ```
  1. Self-bootstraps like `install.sh` (clones the repo when run outside it). Needs git and Node 22.15+,
     the same Node the Bridge already requires; no wrangler, no other tools.
  2. Credentials: if none are saved, prints a pre-filled API-token link
     (`https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=…&name=Baton`, only the
     permissions deployment needs), the user clicks Create and pastes the token (hidden input). The account
     ID is read from the token; token saved in `~/.baton-cloudflare/credentials` (0600) for later runs.
  3. Builds locally (`npm ci` + `npm run build`, the step CodeBuild does on AWS).
  4. Idempotent API calls: create D1 / R2 if missing (R2 must be enabled on the account — the script links to
     it if not), upload the Worker modules + Durable Object class + bindings + static assets, apply
     migrations, generate secrets once, enable `workers.dev` (or attach a custom domain when `--domain` is
     given), upload the Bridge package, set the version.
  5. Prints the same output as AWS: Start URL (12 h) and terminal QR code.
  Re-running the same command upgrades; flags mirror `install.sh` (`--rotate-key`, `OPEN_REGISTRATION=true`,
  `PUSH_RELAY_URL`). The hosted service is deployed with the same script.
- Not chosen as the primary path: the "Deploy to Cloudflare" button (browser only, but needs a GitHub/GitLab
  account, copies the repository into the user's account so later upstream releases are not picked up, and
  deploys with wrangler on Cloudflare's builders). Can be added later as an alternative.

## 6. Phases (user, 2026-11-16)

Measurement behind phase 0: `.scratch/proto-opt/` (per-frame-type counts from the phase-1 recordings,
candidates T1–T16 simulated on the timelines).

**Phase 0 — common protocol optimizations** (App + Bridge only; works on today's AWS). One PR.
- T2: pushes to one App within 50 ms go out as one `batch` frame; the first push after a quiet 50 ms still goes
  at once (StreamFramer's immediate first delta is kept).
- T4: preview tunnel, Bridge → App: the App acknowledges once per 64 KB written (`PREVIEW_ACK_BYTES`), no
  timer — these acks are flow credit only, the Bridge never resends (HTTP/2 `WINDOW_UPDATE` style); the Bridge's
  window grows 128 → 256 KB and resumes as soon as it is below the window, so in-flight data stays ≥ today's.
  App → Bridge (acks also confirm delivery, the App resends) is unchanged. Larger chunks from the server's
  announced frame limit come in phase 1c.
- T7: `notify_seen` becomes a one-way request (`oneWay`: no reply, no resend; its empty `{}` result was unused).
- T8: terminal page heartbeat 30 s → 60 s, page silence limit 90 s → 150 s, Bridge idle limit 90 s → 150 s (still
  tolerates one lost heartbeat).
- T10: terminal `render_ack` when < 16 KB is unreported: at most every 10 s instead of 2 s (the 16 KB / 100 ms
  rule stays, so the 192 KB skip threshold is unaffected).
- Per-type counts: temporary `bridge/frame-stats.mjs` (one module + two call sites, `BATON_FRAME_STATS=1`,
  one summary line per minute, counts and bytes per kind/event/method, no content); deleted after use.
- Not done: T1 (Bridge heartbeat 4/5 → 8–9 min: about $0.02 per Bridge per month on AWS, less margin to the
  10-minute idle close, later offline detection; free on Cloudflare anyway), T3 (terminal output throttle:
  decide with real per-type counts), T6 (delayed `rpc_ack`: user declined).

**Phase 1 — Cloudflare working end to end.**
- 1.0 Verification in `.scratch/` (not committed): R2 checksum dedup / `x-amz-meta-sealed` / Range /
  temporary credentials; Workers static-asset cache headers (#191); D1 vs index object; idle sockets
  without pings; mainland China reachability.
- 1a Contract suite (JS, by URL: register/recover, pairing, revocation, removal + rotation, account isolation,
  notifications, install scripts, version), passing first against the current Python AWS test stack.
- 1b JS core + Cloudflare adapter (Worker, per-account object with relay and SQLite store, global index, R2 with
  delete-after-Bridge-receipt + 1-day expiry, notifications without storage through the push relay, version,
  install scripts, static web app); contract suite passes on Cloudflare.
- 1c Clients: transport chosen from the server announcement (one socket on Cloudflare), disconnect events
  replace leases and renewals (T11), auto-response pings (T12), preview chunks from the announced frame limit
  (T5b), Bridge reconnect jitter; AWS behaviour unchanged. End-to-end acceptance on a test deployment.

**Phase 2 — one-command Cloudflare deploy** (§5): fresh-account install, upgrade and key rotation verified;
the hosted service is deployed with the same script.

**Phase 3 — AWS on the same JS core**: `server/aws` adapter (DynamoDB schema unchanged, existing SigV4 +
fetch, no aws-sdk), same pipeline with a Node image, contract suite + end-to-end acceptance, Python server and
Python tests deleted; existing stacks upgrade without data or client changes.

**Phase 4 — hosted launch items**: `agentbaton.app` + `WEB_URL`; Paid plan; per-account message and connection
limits (the cost ceiling — Workers spending limits do not cover Durable Objects); usage/error alerts and a
per-type dashboard; iOS notification extension decrypting from the push payload (optional push-relay
field); hosted Android notifications (socket vs FCM — FCM needs approval); encryption of videos and
attachments over 50 MB; mainland China test; slim envelope + `stream_end` with ids only (T14, T16, or in 1c).

Each PR: design details first → user OK → implement → self-test → PR to `feat/v2` → independent review
(reproducible findings only, simplest implementation, no regressions vs base) → fix + re-review → end-to-end
acceptance on separate test resources → report → squash merge on OK → delete test resources.

## 7. Carried over from earlier phases

- Hosted Android notifications (accounts plan D4): off until phase 4.
- Videos and large files are sealed too (`docs/media-streaming.md`).
- "Being viewed" suppression may move to the relay object, which knows live subscriptions (optional).
- REST limits from PR #229 (register / recover / pair-start per IP, computers per account) carry over to both
  adapters.

## 8. Details to confirm (filled in as decided)

1. ~~Release artifacts~~: decided — AWS keeps building from source in CodeBuild; Cloudflare builds locally
   in its install script (§5).
2. Web app hosting: AWS as today (served by the Lambda); Cloudflare Workers static assets — confirm the
   cache headers fixed in #191 can be reproduced there.
3. Global index on Cloudflare: D1 vs an index object; key formats; token format with account ID.
4. R2 compatibility: checksum-verified dedup, `x-amz-meta-sealed`, Range reads, temporary credentials.
5. Cloudflare plan and limits: Free vs Paid at launch, per-account message quotas, alerting.
6. DO placement policy (Bridge first, or a location hint from the Bridge's region).
7. Frame size limit per platform (profile A 32 KB; Cloudflare up to 32 MiB received — pick a cap).
8. Mainland China reachability test method.
9. Cloudflare install script details: exact token permissions, where the Bridge package lives (R2 vs static
   assets), Free-plan deploys for self-hosters (Durable Objects on Free are SQLite-only; R2 activation).
10. Notifications without storage: the sealed alert (`e`, 1–2 KB) travels in the APNs payload (4 KB limit);
    on Cloudflare the Bridge hands it to its account object over its socket, which reads the push devices and
    calls the push relay. AWS keeps the feed rows for self-host Android polling.
11. Attachment retention: hosted deletes phone→computer uploads once the Bridge has stored them and expires
    the rest after 1 day; self-host keeps 7 days (one setting per adapter). Check that every attachment entry
    point falls back to the Bridge's local copy.
12. Push relay stays on AWS Lambda (saves ~$15/month at 100k DAU if moved; APNs needs HTTP/2 from Workers —
    unverified; all self-host stacks authenticate to it with IAM). Revisit after launch.
