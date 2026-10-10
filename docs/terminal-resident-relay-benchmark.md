# Terminal Standalone WSS Relay: Cross-EC2 Comparison Results

> Historical experiment record: on 2026-09-16 the temporary test scripts from this round were deleted as requested. The experiment paths and reproduction commands here only describe the method used at the time;
> they are no longer executable entry points in the current repository. For the current implementation and cloud test entry points, see `docs/terminal-direct-integration.md`.

Date: 2026-09-16. Region: `ap-northeast-1`.

Later constraint: the user explicitly ruled out an EC2 / Fargate resident relay; this document only keeps the performance comparison and is not a deployment recommendation.
The Gateway HTTP / SigV4 path, which needs no self-hosted service, has been made to work; see `docs/terminal-connections-benchmark.md`.

## Conclusion

**A standalone WSS relay that bypasses per-message Lambda works, and this cross-host measurement shows a clear benefit.**
The current Gateway + Lambda 128MB path has a pure-message two-end round-trip p50 of 144–147ms;
the standalone WSS relay's two rounds had p50 of 1.64ms and 1.87ms, and p95 of 1.81ms and 2.09ms.

This is a synthetic-message test on same-region EC2, excluding public-internet clients, PTY, xterm, and page rendering.
It cannot be described as "the user's terminal went from 500ms down to 2ms", nor can all of the gain be attributed to the Lambda function itself.
The new path also eliminates per-message Lambda dispatch, DDB route lookups, and Management API HTTP callbacks, and the resource configuration differs too.

## Test Topology and Methodology

```text
Baseline: App on test EC2 ──WSS── Gateway / Lambda / DDB / callback ──WSS── Bridge on same EC2
Relay:    App on test EC2 ──WSS── relay on another EC2                ──WSS── Bridge on same EC2
```

- The client is `ssh test-ec2-ap`, instance type `c8i.4xlarge`.
- The relay runs on a newly created standalone `t3.small`, in the same VPC, same subnet, and same AZ `ap-northeast-1d` as the client.
  The two instances are different, not a same-host loopback. The relay uses its VPC private address, without going through ALB/CloudFront.
- Both ends' messages were actually sent and received by scripts on EC2; timing used the monotonic clock inside EC2, and SSH was used only to start runs and fetch reports.
- Both paths reuse the same `measure()`, the same business fields, and one-byte Base64 input / verbatim output.
  Clients are all `websocket-client==1.9.0`. Each group has 3 warm-ups and 100 measurements, with no artificial waits between samples.
- Order was Gateway pre-baseline → WSS relay round 1 → WSS relay round 2 → Gateway post-baseline.
  Both sides verified input and output sequence numbers and byte content; send completion or ACK was not used in place of actual receipt.
- Gateway still uses the original `Baton-ws-handler` 128MB, with no changes to code, memory, routes, or tables.
- The relay is a resident Python process on `websockets==15.0.1`; it validates a test token at handshake and binds role and device;
  the data path only does validation, connection lookup, and forwarding, with no per-message HTTP or database requests and no fixed batching wait.
- The networks of the two paths are not identical: Gateway Ping p50 3.34ms, relay Ping p50 0.69ms.
  So this is a comparison of complete deployment paths, not a function micro-benchmark with network, CPU, and all other factors strictly isolated.

## Measured Results

Unit: milliseconds. p50/p95 use the nearest-rank method; all valid measurement samples are kept, and no slow samples were removed.

| Two-end message round trip | min | p50 | p95 | max |
|---|---:|---:|---:|---:|
| Gateway + Lambda 128MB, pre-baseline | 111.13 | 147.46 | 210.66 | 301.93 |
| Standalone WSS relay, round 1 | 1.47 | 1.64 | 1.81 | 1.90 |
| Standalone WSS relay, round 2 | 1.63 | 1.87 | 2.09 | 2.22 |
| Gateway + Lambda 128MB, post-baseline | 110.62 | 143.90 | 182.07 | 346.24 |

The relay recorded 412 forwards, i.e. per round `(3 warm-ups + 100 measurements) × two forwards (input/output)`.
From the relay handler starting to process a message to `await peer.send()` completing, p50 is about **0.102ms** and p95 about **0.125ms**.
This is not pure CPU time, nor does it mean the data has reached the client; the table is authoritative for actual two-end receive time.

This round is a low-concurrency interactive benchmark over already-established connections. Cold start, a public WSS entry point, multi-user concurrency,
large PTY output, mobile network handoff, and disconnect recovery have not been tested; the same latency under all loads cannot be promised from this.

## Relationship to the Previous VPN / EC2 Comparison

The previous round used one fixed API for an EC2 → local machine → EC2 comparison, 30 samples per group:

| Metric, p50 | Local, current network | Tokyo EC2 |
|---|---:|---:|
| Gateway native Ping/Pong | 187.88ms | 2.34 / 3.72ms |
| Gateway + Lambda two-end message round trip | 522.27 / 526.48ms | 158.75–161.11ms per group |

At that time the local machine's IPv4 route to Gateway clearly went through the `utun6` tunnel interface; EC2 used ordinary VPC routing.
This shows the roughly 500ms measured locally earlier was not pure cloud processing time, but the whole difference cannot be attributed to VPN,
because machine location, internet path, operating system, etc. also changed. The net effect of VPN still needs a same-machine on/off comparison.

The previous round also re-tested AppSync Events: EC2 two rounds had p50 of **282.69ms, 113.34ms**,
and p95 of **454.29ms, 271.23ms**; the local p50 in that round was **605.24ms**.
Results fluctuated; it cannot be said AppSync is always slower, but it also did not show the low latency and stability the standalone WSS showed this time.

AppSync's native Ping/Pong additionally showed EC2 round trips of about 1 second, while data post-back on the same service was faster.
So WS Ping/Pong for every service cannot be taken directly as pure network RTT, nor mechanically subtracted from message time.
RFC 6455 §5.5.2/5.5.3 describes how an endpoint responds to Ping and does not guarantee it is a pure network timer:
`https://www.rfc-editor.org/rfc/rfc6455.html`.

## Security Boundary and Cleanup

- The temporary relay security group only allowed the test EC2's private IPv4 `/32` to 28443; WSS or SSH were not opened publicly.
- TLS was enabled; the client pinned trust to this round's certificate and verified the certificate name; `CERT_NONE` was not used and hostname verification was not disabled.
  Local functional checks additionally verified that a wrong token and a wrong TLS hostname are rejected.
- Test tokens were generated independently; the Gateway baseline also used a separate synthetic account, and no real account or long-term AWS credentials were passed to the test EC2.
- The relay process ran as a non-root user with filesystem protection enabled; no IAM instance profile.
  It has a 28KiB frame limit, role/device/ownership checks, queue/write-buffer limits, and at most 8 test connection groups.
- This relay only supports test `input`/`output` events and a monitoring interface; **it does not execute commands or start a Shell or PTY**.
  It must not be deployed directly as a production terminal service.
- The instance was set to auto-shutdown 20 minutes after boot with terminate-on-shutdown, as a fallback if cleanup failed; on normal completion it was terminated proactively.
  The temporary security group and the virtual environment and files on the test EC2 were all deleted.
- The existing Web, Bridge, Gateway, and Lambda were not switched; current user terminals still use the original path.

## Reproducible Files

- `test/server/ws_resident_relay.py`: standalone, limited-purpose WSS relay.
- `test/server/ws_resident_compare.py`: reuses the original measurement logic, runs the pre/post Gateway baselines and two relay measurement rounds.
- `test/server/run_ws_resident_probe.py`: creates the temporary instance/security group, prepares the remote client, runs the test, and cleans up.
- `test/server/ws_network_bench.py`: previous round's local/EC2 network comparison.
- `test/server/test_ws_resident_relay.py`: token, role, device, ownership, size, and protocol validation tests.

Running requires the relevant AWS resource permissions and existing SSH access; the script only creates resources with an explicit `--run`:

```bash
python3 test/server/run_ws_resident_probe.py --run \
  --ssh-host YOUR_TEST_HOST --client-instance YOUR_TEST_INSTANCE_ID \
  --gateway-url YOUR_EXISTING_WSS_ENDPOINT --samples 100
```

This round's private system temporary directory: `terminal-resident-relay-ktlwp51n`, containing `comparison.json` and `metadata.json`.
Previous round's network comparison directory: `terminal-network-comparison-sge7bna1`.
Temporary credentials, certificate private keys, console captures, or raw private reports are not committed to Git.

## Minimal Next Implementation Path

Keep the existing REST / Gateway WS for management, device presence, and authentication; only add an optional standalone WSS data channel for terminals:

```text
Existing API: authentication, device selection, issuing short-lived session tickets
Terminal data: Web / xterm ⇄ WSS Relay ⇄ Bridge / PTY
```

Next, first wire up the existing PTY controller and xterm for a real interactive loop, without adding usability features such as input hints.
Reuse the existing sequence numbers, ACK, frame limits, backpressure, leases, and disconnect handling; data must not be re-executed automatically through retries.
A production entry point also needs a valid public certificate, session-level tickets and authorization, an Origin policy, operational monitoring, capacity validation, and a fallback switch.
For multi-process/multi-instance deployment, the corresponding App and Bridge must be guaranteed to pair correctly; a load balancer cannot be assumed to do this automatically.
