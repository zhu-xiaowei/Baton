# API Gateway @connections: Isolated Runtime Verification

> Historical experiment record: on 2026-09-16 the temporary test scripts from this round were deleted as requested. The experiment paths and reproduction commands here only describe the method used at the time;
> they are no longer executable entry points in the current repository. For the current implementation and cloud test entry points, see `docs/terminal-direct-integration.md`.

Date: 2026-09-16. Region: `ap-northeast-1`.

> Later integration finding: restricting the IAM Resource to a specific connection ID did not hold up in practice.
> This document proves transport and latency, not per-connection authorization. The actual POC switched to a separate data API + per-session HMAC;
> for the implementation and security boundary, see `docs/terminal-direct-integration.md`.

## Conclusions and Constraints

- The user explicitly does not accept an EC2 / Fargate resident relay; the earlier self-hosted WSS was only a performance baseline, not a plan to ship.
- **Both ends keep WebSocket, the client attaches a SigV4 signature, and a Gateway HTTP integration calls
  `@connections` directly to forward to the peer; this path has been runtime-verified on both ends.** No self-hosted relay is needed, and no per-message Lambda.
- Also verified: the client directly sends a signed HTTPS POST and the peer receives it over WS, as a baseline for forwarding overhead.
- Gateway still does not discover / pair clients automatically; the target connection ID must be obtained securely, along with short-lived signing permissions,
  terminal session binding, and message ordering control. Deleting Lambda or merely configuring an IAM role is not enough.
- In this test, HTTP integration + `CredentialsArn` returned 403; do not treat Gateway auto-signed forwarding as usable.
- The OPTIONS preflight for a standard cross-origin Authorization-header POST returned 403 with no CORS allow headers.
  **The both-ends-WS approach does not require the browser to perform this HTTP POST**: the signing material is passed to Gateway over WS,
  and Gateway requests `@connections` server-side. A real browser xterm is not yet wired in; EC2 verification is not browser acceptance.

## 1. Topology and Timing

All clients ran on the existing `test-ec2-ap`; no new EC2 was created and no resident service was deployed.

```text
Original path:
Simulated App ─WS→ Gateway → Lambda → @connections → Gateway ─WS→ Simulated Bridge
Simulated App ←WS─ Gateway ← @connections ← Lambda ← Gateway ←WS─ Simulated Bridge

Signed direct push:
Simulated App ─signed HTTPS POST→ @connections ─WS→ Simulated Bridge
Simulated App ←WS─ @connections ←signed HTTPS POST─ Simulated Bridge

Both ends keep WS:
Simulated App ─WS(message+signature)→ Gateway HTTP integration → @connections ─WS→ Simulated Bridge
Simulated App ←WS─ @connections ← Gateway HTTP integration ←WS(message+signature)─ Simulated Bridge
```

- A new isolated WebSocket API was created; `$connect` uses `AWS_IAM` with no backend integration configured.
  The official docs allow omitting the `$connect` integration; the earlier MOCK handshake 500 is not evidence that the post-back interface is unusable.
- `hello` uses MOCK to return its own connection ID; no DynamoDB, no terminal process, no Lambda.
- STS temporary credentials are valid for 900 seconds, scoped only to connecting to and posting back on the specified stage of the temporary API.
  They are passed to the client only via SSH stdin; no long-term AWS credentials or real Baton API Key are passed.
- The original-path baseline uses a synthetic account and a separate device name, and sends no commands to a real Bridge.
- Same `measure()`, one-byte base64 input echoed back verbatim, 3 warm-ups then 100 samples per group.
- All times use the EC2 local monotonic clock; they include signing, sending, bidirectional forwarding, and the actual WS receive event, excluding SSH time.
- The direct-push client reuses HTTP connections with SDK automatic retries disabled. Two worker threads send POSTs; the receiver reads WS without waiting
  for the HTTP response; finally all POST responses are checked to be 200. No fixed batching delay or sleep between samples.
- Excludes real PTY, browser rendering, user public internet / VPN, multi-user concurrency, and mobile network handoff.

## 2. 100-Sample Results

### 2.1 Final Both-Ends WS and Same-Round Baselines

After fixing the signing path, ran in the order Gateway pre-baseline → HTTP direct push → WS header signature → WS query signature →
HTTP direct push → Gateway post-baseline, each with 3 warm-ups and 100 samples.
Full two-end message round trip, unit ms:

| Approach | min | p50 | p95 | max |
|---|---:|---:|---:|---:|
| Gateway + Lambda 128MB, pre-baseline | 116.54 | 159.24 | 181.95 | 298.03 |
| Client-signed HTTP direct push, group 1 | 17.73 | 21.52 | 30.81 | 82.03 |
| **Both ends WS, Gateway HTTP forwarding with header signature** | 24.82 | **35.74** | **59.13** | 155.13 |
| **Both ends WS, Gateway HTTP forwarding with query signature** | 27.87 | **34.28** | **61.26** | 99.09 |
| Client-signed HTTP direct push, group 2 | 16.20 | 20.12 | 28.82 | 125.42 |
| Gateway + Lambda 128MB, post-baseline | 119.86 | 157.18 | 210.75 | 247.45 |

The both-ends-WS approach has a median round trip of about 34–36ms, versus 157–159ms for the original path in the same round; sequence numbers and data were checked one by one.
Data display did not artificially wait for the HTTP integration's response ACK; the receive function skipped diagnostic ACKs and waited for the target data frame.
All long tails are kept; one low-concurrency experiment cannot prove query signing is faster than header signing, nor does it promise public-internet terminal echo of only 35ms.
Final report directory ID: `terminal-connections-runtime-o2h5tlr1`.

### 2.2 Earlier Client HTTP Direct-Push Baseline

Full two-end message round trip, unit ms:

| Approach | min | p50 | p95 | max |
|---|---:|---:|---:|---:|
| Gateway + Lambda 128MB, pre-baseline | 114.43 | 159.96 | 182.17 | 270.34 |
| Signed HTTP direct push, group 1 | 16.00 | **23.06** | **30.74** | 120.88 |
| Signed HTTP direct push, group 2 | 16.91 | **21.21** | **27.44** | 29.40 |
| Gateway + Lambda 128MB, post-baseline | 111.51 | 158.55 | 199.00 | 266.57 |

The two direct-push groups sent 412 POSTs in total (including warm-ups), all returned 200, and the actually received sequence numbers and contents were checked one by one.
Group 1 kept a 120.88ms long tail; outliers were not removed, and without evidence it is not attributed to cold start or network.
This shows the cloud forwarding time in this round can be cut significantly without a self-hosted resident relay; it does not promise a 21ms final input echo for public-internet users.

## 3. Encoding Issue in Gateway Direct Forwarding

Initially, mapping the client SigV4 header / query into the HTTP integration returned 403 in both cases.
After adding safe boolean diagnostic fields, it was confirmed to be a signature mismatch, not an inability to pass the signature through:

- The URL used by a direct SDK POST encodes the trailing `=` of the connection ID as `%3D`.
- The test Gateway integration's path mapping actually keeps `=`; if the signature is computed over the SDK's pre-encoded path,
  the SigV4 canonical URI does not match the actual request.
- After signing the path the integration actually sends, both header and query delivery returned **200**,
  and the peer received an identical synthetic message.

This result cannot be generalized into an encoding rule for arbitrary URIs / characters; the implementation must compute the signature consistently over the actually sent method, host, path,
query, signed headers, and body. Nor can a single 403 be used to claim HTTP post-back is unsupported.
Separate functional verification report: `terminal-connections-runtime-_1g7fxvo`.

## 4. Signing and Browser Boundary

Runtime verification distinguished the following cases, rather than only checking whether `create_deployment` succeeded:

| Call method | Status | Peer received correct content |
|---|---:|---|
| Gateway HTTP integration, unsigned | 403 | No |
| Gateway HTTP integration, `CredentialsArn` configured | 403 | No |
| Gateway HTTP integration, client header signature matching actual path | 200 | Yes |
| Gateway HTTP integration, client query signature matching actual path | 200 | Yes |
| Client SDK SigV4 Authorization header, direct POST | 200 | Yes |
| Client SigV4 query, request body kept and signed, direct POST | 200 | Yes |
| Same query signature but tampered body | 403 | No |
| Browser-style OPTIONS preflight, Authorization / date / token headers | 403 | N/A |

Query signatures use a 60-second validity, the signature is bound to the body, and `UNSIGNED-PAYLOAD` is not used.
This does not put arbitrary terminal commands in the URL, nor does it hand long-term admin keys to the frontend.
A direct query POST with `Origin: http://localhost:5173` and `Content-Type: text/plain` posted back successfully,
but the HTTP response had no `Access-Control-Allow-Origin`. This is HTTP-client verification, not actual browser acceptance.
If the browser uses a simple request / `no-cors`, opaque responses, WS confirmation, error feedback, CSP, and disconnect behavior still need separate verification;
this cannot be used to claim a standard cross-origin SDK call from the browser works.

## 5. Must Be Solved Before Wiring Up a Real Terminal

1. The existing authenticated API issues short-lived, least-privilege credentials bound to account, device, role, terminal session, and peer connection ID;
   the experiment's IAM policy "allow post-back anywhere under the isolated API" cannot be reused directly.
2. Actual browser handshake and signing implementation for both-ends WS, without putting a long-term AWS Secret in the page;
   if direct client HTTP is chosen, handle CORS / opaque responses separately rather than confusing it with Gateway's server-side POST.
3. Concurrent HTTP sends may arrive out of order; keep the existing sequence numbers, reorder window, ACK, backpressure, and input size limits.
4. Re-authorize on connection change, credential expiry, and revocation; do not replay terminal input after a disconnect.
5. Large PTY output, real xterm echo, Vim, Ctrl-C, resize, public-internet links, and concurrency load testing.

Client-reported `replyConnectionId` / account / role must not be injected as server-side identity.
When changing the forwarding path, trusted session-ownership checks must be kept; a request merely carrying a SigV4 signature does not mean terminal authorization is complete.

The existing API / Bridge / frontend have not switched to this path. This round only added reproducible tests and documentation.

## 6. Reproduction and Cleanup

```bash
python3 test/server/ws_connections_runtime_probe.py --run \
  --ssh-host test-ec2-ap \
  --gateway-url wss://jp53wzd7yd.execute-api.ap-northeast-1.amazonaws.com/v1 \
  --samples 100
python3 -m pytest -q test/server/test_ws_connections_runtime_probe.py
```

Without `--run` it only shows help by default. `--functional-only` runs only functional / negative verification, without the latency baseline.
The script creates a temporary API, IAM role, log group, and a temporary venv on the existing EC2; `finally` deletes these resources.
All phases, full samples, and cleanup records are saved in a private local temporary directory; signed URLs, credentials, or raw authorization frames are not committed.
Earlier HTTP direct-push 100-sample report directory ID: `terminal-connections-runtime-a83ulql1`;
final both-ends WS 100-sample report directory ID: `terminal-connections-runtime-o2h5tlr1`.

Final audit: the APIs / IAM roles from all 9 isolated experiments in this round no longer exist, and all EC2 temporary directories were deleted;
test log groups that reappeared later due to CloudWatch asynchronous delivery were also cleaned up.
The production `Baton-ws-handler` is still 128MB with the same code SHA as before testing; no API / Bridge business changes were deployed.
Test results: `test/server` 122 passed, 15 pre-existing deprecation warnings; `git diff --check` passed.

## 7. Same-API Comparison: Local Machine vs EC2

As requested by the user, using the same isolated API, ran in order **EC2 pre-test → local machine → EC2 post-test**.
Each location included: original Lambda path pre-baseline, header-signed WS, query-signed WS, original path post-baseline,
each group with 3 warm-ups then 100 samples; plus 30 native WS Ping/Pong samples for each of the two Gateway endpoints.

```bash
python3 test/server/ws_connections_runtime_probe.py --run \
  --gateway-url wss://jp53wzd7yd.execute-api.ap-northeast-1.amazonaws.com/v1 \
  --samples 100 --ws-only --locations ec2 local ec2
```

`--ws-only` keeps smoke checks for both actual forwarding modes; if either fails, the performance test is not run. It skips the previously verified
HTTP direct push and bad-signature negative experiments, to avoid mixing them into this both-ends WS comparison.
In the local phase both simulated ends were on the local machine, and in the EC2 phase both were on EC2; not a mixed topology with one end local and one on EC2.
Timing includes actual message delivery, excluding SSH, connection setup, credential issuance, and environment setup time, with no artificial waits between samples.

Environment record: local macOS / Python 3.12.4; EC2 Linux / Python 3.9.25.
boto3 is 1.42.32 on both, websocket-client is 1.9.0 on both; botocore is 1.42.32 locally and 1.42.97 on EC2.
So payload, code, and service config are the same, but the OS / Python / underlying SDK environment is not identical; not every difference can be attributed to VPN.
Before and after each phase, the IPv4 route to the target domain and the names of proxy environment variables were recorded; proxy credentials were not read or recorded, and the VPN was not toggled.

This round's report directory ID: `terminal-connections-runtime-wmd_guik`.
Group files: `ec2-1.json`, `local-2.json`, `ec2-3.json`; `runtime-details.json` records the underlying SDK versions.
### 7.1 Results of This Round

All of the following are full two-end message round trips, unit ms; each cell is **p50 / p95**, not one-way latency:

| Approach | EC2 pre-test | Local, current network | EC2 post-test |
|---|---:|---:|---:|
| Original Lambda path, pre-baseline | 142.10 / 208.21 | 521.34 / 560.05 | 159.15 / 222.88 |
| New path, header-signed WS | **37.12 / 67.55** | **416.89 / 499.01** | **39.79 / 56.71** |
| New path, query-signed WS | **33.01 / 48.99** | **423.31 / 511.59** | **36.10 / 49.71** |
| Original Lambda path, post-baseline | 159.29 / 187.23 | 527.69 / 599.11 | 157.97 / 188.21 |

- Local median round trip dropped from 521–528ms to 417–423ms, a reduction of about 100ms (about 20%).
- On EC2, the new-path medians in both rounds were 33–40ms, versus 142–159ms for the original path. No "overall p50" was produced by averaging percentiles across groups.
- The local header-signed new path still had a maximum of **882.41ms**, while the two original-path groups had maxima of 741.46 / 687.82ms.
  All long tails are kept; it cannot be claimed that every input is faster or that jitter has disappeared.
- The relative order of the two signing methods differed across machines; this round's small gaps cannot establish that query or header is always faster.

### 7.2 Network Observations and Interpretation Limits

Native WS Ping/Pong, 30 per group, p50 below, unit ms:

| Endpoint | EC2 pre-test | Local | EC2 post-test |
|---|---:|---:|---:|
| Original Gateway | 0.98 | 189.04 | 2.58 |
| Isolated direct-forward Gateway | 3.00 | 191.14 | 1.85 |

On the local machine, the resolved IPv4 addresses of both endpoints routed through **`utun6`** before and after testing; on EC2 before and after it was
the VPC NIC **`enp39s0`**. The proxy environment variable lists were empty on both, but an empty list does not mean no VPN / tunnel was traversed.
The user's VPN, system proxy, and routes were not modified.

Locally, both the simulated App and Bridge go through cloud forwarding, so a full echo includes multiple public-internet transits, while native Ping measures only one
control-frame round trip. The new approach reduces application forwarding overhead; it cannot bring local public-internet latency down to the EC2 same-region level.
Ping also includes service response behavior; Ping and message p50 from different groups cannot be subtracted precisely to get "pure Lambda time".

This round proves the observed differences under the current two machines and networks. Geographic location, network path, OS, Python, and underlying SDK
differ, so **the entire local-vs-EC2 difference cannot be attributed to VPN**; the net effect of VPN needs a separate same-machine on / off comparison.
The test still uses synthetic Python clients and excludes real PTY, xterm rendering, the browser's own proxy policy, and mobile device input.

New tests and report feature verification: server 126 passed, 15 pre-existing deprecation warnings; `git diff --check` passed.
The 12 groups kept 1,200 valid timing samples in total, and the percentiles in the report were checked item by item.
This round's final audit confirmed the temporary API / IAM role / EC2 venv / test log groups were all cleaned up,
the production Lambda is still 128MB with an unchanged code SHA; the existing API, Bridge, and browser POC did not switch transport paths.

## Official References

- `https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-how-to-call-websocket-api-connections.html`
- `https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-route-keys-connect-disconnect.html`
- `https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-integration-requests.html`
- `https://docs.aws.amazon.com/apigateway/latest/developerguide/websocket-api-data-mapping.html`
