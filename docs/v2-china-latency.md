# v2: improving latency from mainland China (hosted service)

Status: plan, 2026-11-20. Nothing here is implemented yet. Decisions are the user's; options are ordered by cost.

## 1. Measurements

| Path | REST (devices) | WebSocket |
|---|---|---|
| Cloudflare hosted (`api.agentbaton.app`), company Wi-Fi in China | ≥ 250 ms | ~800 ms, unstable |
| AWS `Baton` stack, Tokyo, direct (REGIONAL REST API, API Gateway WebSocket; no CloudFront) | ~150–170 ms | ~110 ms |
| Cloudflare, Tokyo client → Tokyo DO (2026-11-16 spike) | — | one-way p50 8–9 ms |
| Cloudflare, US-East client → US-East DO | — | echo p50 ~25 ms |

Phone tests (2026-11-17, `apac-test`): China Telecom enters Cloudflare at **AMS**, China Unicom at **LAX** (China Mobile untested; community reports HKG). China → edge RTT is 230–320 ms before any Worker or DO work. A DO placed in APAC was *slower* for mainland users (AMS/LAX → Asia → back). R2: WEUR fastest for Telecom, WNAM for Unicom; ENAM is the compromise.

## 2. Where the time goes (today)

```
App in China ──(250–320 ms, via AMS/LAX)──► Cloudflare edge ──► account DO ──► Bridge's edge ──► Bridge
```

- **China → edge**: fixed by the carrier's peering. Free/Pro/Business plans cannot change it. Only Enterprise China Network (ICP filing, JD Cloud) can.
- **Edge → DO**: a DO is created near the first request that touches it and never moves. The user's account DO was created from a phone via AMS. A Bridge in Tokyo then adds ~230 ms RTT per message, and an App entering at LAX adds ~150 ms more.
- Packet loss on the long international leg costs retransmits on top. This is the "unstable" part.

## 3. Options

### A. Cloudflare-native, no extra cost (recommended first)

| # | Change | Expected effect | Size |
|---|---|---|---|
| A1 | **Place the account DO near the Bridge.** Pass a `locationHint` derived from the creating Bridge's entry colo (`request.cf.colo`/continent) at pairing/registration, instead of letting the first App request decide. The Bridge is always online and is one end of every message. | −100–200 ms per request when the App and Bridge enter in different regions (e.g. App in China, Bridge in Tokyo). No change when both are in China. Existing accounts keep their DO (re-pair to move). | ~20 lines |
| A2 | **Enable TLS 0-RTT** on the zone (today: off; HTTP/3 and TLS 1.3 already on). | One round trip (~250 ms from China) saved on every resumed connection, e.g. iOS returning from the background. Check first how Cloudflare treats 0-RTT on non-idempotent requests (replay). | setting |
| A3 | **Fewer sequential requests at App start**: issue the start-up REST calls (devices, version, credentials) in parallel or merge them. | ~250 ms per removed round trip from China. | small |
| A4 | **Reconnect immediately** on foreground and network change, not after a missed 25 s ping. | Fewer stuck or slow-feeling sessions. | small |

Not useful: Argo Smart Routing (accelerates edge → origin, which DO traffic does not use); Pro/Business zone plans (same mainland routing); "优选 IP" tricks (unstable, ToS risk).

Expected result for mainland users after A1–A4: roughly 300–400 ms instead of 500–800 ms. The China → edge leg stays, so this cannot match AWS Tokyo's ~110 ms.

### B. A small Tokyo/HK relay in front of Cloudflare (~$5–10/month)

```
China ──(60–110 ms)──► Tokyo relay (TCP/TLS passthrough) ──► Cloudflare NRT ──► APAC DO ──► Bridge
```

- Lightsail/EC2 nano in Tokyo running an L4 passthrough (nginx `stream`). It does not terminate TLS, so certificates and end-to-end encryption are unchanged.
- New host, e.g. `api-cn.agentbaton.app`. Clients probe `api.` and `api-cn.` at start and keep the faster one (~50 lines). Overseas users are unaffected.
- New mainland accounts then get DOs in APAC. Existing accounts re-pair.
- Costs and risks:
  - **All mainland users appear as one IP to Cloudflare**, so the WAF rule and the per-IP register/pair limits must exempt the relay. The $1/month account cap stays as the backstop.
  - **The relay is a single point**: clients fall back to `api.` if it fails.
  - **China → Tokyo routes also vary**: test at evening peak first.
- Try as a 1–2 day experiment with a comparison page before committing.

### C. Hosted API + WebSocket on AWS Tokyo serverless, files on R2

The existing `Baton` stack's experience (~110 ms). Small code change: open registration on AWS, and AWS issues R2 temporary credentials (reuse `server/cloudflare/r2.mjs`). The web app, homepage and `dl.` stay on Cloudflare. Nearly free while users are few, but ~$33–55k/month at 100k DAU (API Gateway WebSocket messages + Lambda).

### D. Hosted on EC2 Tokyo (+ optional CloudFront)

The same latency as C, with a fixed cost. New `server/ec2` adapter (~900–1,200 lines: Node HTTP + WebSocket server, in-process per-account relay like the DO, DynamoDB or SQLite, deploy).

Estimated ~$800–1,500/month at 100k DAU:

| Item | Cost/month |
|---|---|
| ~3–4 instances, for 100k always-on Bridge sockets | $250–300 |
| ALB (active-connection LCUs) | ~$200 |
| Egress (~4.4 TB) | ~$400–500 |
| DynamoDB and monitoring | ~$50 |

CloudFront flat-rate plans (Pro $15: 10M requests, 50 TB; Business $200: 125M requests) cover egress but not compute, and their request allowance runs out first. WebSocket can bypass CloudFront: AWS Tokyo direct already measures ~110 ms.

Other costs and risks:
- Without CloudFront: TLS (ALB or ACME), no edge WAF.
- Single-instance availability and deploys drop sockets.
- Multi-instance needs account affinity.
- Overseas users reach Tokyo at ~150–250 ms.

### E. Cloudflare Enterprise China Network

Changes the mainland entry itself; needs ICP filing per domain and an Enterprise contract. Not considered now.

## 4. Cost at 100k DAU (rough)

| Option | Monthly |
|---|---|
| Cloudflare (today) | ~$200–300 |
| B: Cloudflare + Tokyo relay | ~$210–320 (one or a few small relays) |
| C: AWS serverless | ~$33–55k |
| D: AWS EC2 | ~$800–1,500 |

## 5. Next steps

1. **Measure first.** Build a test page that reports the entry colo, App → DO RTT and the full App → DO → Bridge → App RTT. Run it from company Wi-Fi, home and 5G (including evening peak), and from the US-East and Tokyo boxes for overseas numbers.
2. **Do A1 + A2**, the largest effect for the least change, then A3/A4. Re-measure.
3. **If mainland latency is still the main complaint**, run the B experiment, then decide B, or C/D, by user geography.
