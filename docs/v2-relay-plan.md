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
| 5 | Each platform deploys with one command. No new third-party dependencies (Cloudflare deploys through its HTTP API, no wrangler). |
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
server/core/        routes and rules (accounts, pairing, tokens, devices, notifications, install, version)
                    on web-standard Request/Response; talks to ports: storage, connections, files, push
server/aws/         Lambda (Node 22) entry; DynamoDB (SystemTable, same schema); API Gateway control socket
                    and @connections; STS credentials for the data API and S3 (profile A, as today)
server/cloudflare/  Worker entry; Durable Object per account = relay + SQLite account storage;
                    global index (pairing codes, recovery, rate limits) in D1 or an index object; R2 files
```

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

- **Artifacts:** the build (Vite `dist/` + server bundle + Bridge package) is produced once by CI per release,
  with a checksum. Self-host `install.sh` downloads the release artifact for its version and uploads it to the
  stack bucket — no Docker, ECR or CodeBuild, no Node on the deploying host. Development deploys build
  locally (`npm run build`) and upload the same zip shape. (Proposal; see §8 item 1.)
- **AWS:** Lambda runtime `nodejs22.x`, zip package from the stack bucket; CloudFormation template keeps API
  Gateway (REST, WsApi, data API), CloudFront and DynamoDB as they are. The web app is served as today.
- **Cloudflare:** one script calls the Cloudflare API: upload the Worker (module + DO class + D1/R2 bindings
  + static assets), run migrations, set secrets, attach the custom domain. Usable for self-hosting on a
  user's own Cloudflare account too.

## 6. PR order

0. **Protocol optimizations, platform independent** (measure per frame type first): fewer messages
   (coalesce small frames, larger chunks where the transport allows), slimmer clear envelope, binary frames
   without base64 of ciphertext. Count matters on Cloudflare, bytes on CloudFront/S3.
1. **JS server + AWS adapter**, behaviour-identical to the Python server; zip deployment; Python deleted;
   acceptance on a separate test stack.
2. **Cloudflare adapter**: relay object, account storage, global index, R2, deploy script; acceptance on a
   test Cloudflare deployment.
3. **Clients**: transport selection from the server announcement; on Cloudflare, disconnect events replace
   subscription leases and renewals; Bridge reconnect jitter.
4. **Launch items**: `agentbaton.app` + `WEB_URL`, monitoring and alerts, per-account limits (the cost
   ceiling on Cloudflare; Workers spending limits do not cover Durable Objects), hosted Android notifications
   (socket vs FCM, FCM needs approval), encryption of videos and attachments over 50 MB.

Each PR: design details first → user OK → implement → self-test → PR to `feat/v2` → independent review
(reproducible findings only, simplest implementation, no regressions vs base) → fix + re-review → end-to-end
acceptance on separate test resources → report → squash merge on OK → delete test resources.

## 7. Carried over from earlier phases

- Hosted Android notifications (accounts plan D4): off until PR 4.
- Videos and attachments over 50 MB stay plain under the account prefix until PR 4 (`SEALED_MAX`).
- "Being viewed" suppression may move to the relay object, which knows live subscriptions (optional).
- REST limits from PR #229 (register / recover / pair-start per IP, computers per account) carry over to both
  adapters.

## 8. Details to confirm (filled in as decided)

1. Release artifacts: where CI publishes them (GitHub Releases vs a public bucket), how dev deploys differ.
2. Web app hosting per platform (Lambda as today vs S3/CloudFront; Workers static assets on Cloudflare) and
   the cache headers fixed in #191.
3. Global index on Cloudflare: D1 vs an index object; key formats; token format with account ID.
4. R2 compatibility: checksum-verified dedup, `x-amz-meta-sealed`, Range reads, temporary credentials.
5. Cloudflare plan and limits: Free vs Paid at launch, per-account message quotas, alerting.
6. DO placement policy (Bridge first, or a location hint from the Bridge's region).
7. Frame size limit per platform (profile A 32 KB; Cloudflare up to 32 MiB received — pick a cap).
8. Mainland China reachability test method.
