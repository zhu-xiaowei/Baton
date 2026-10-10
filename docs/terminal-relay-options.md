# Terminal Relay Selection: Official Basis and Isolated Validation

> Historical experiment record: the temporary test scripts from this round were deleted as requested on 2026-09-16. The experiment paths and reproduction commands here only describe the method used at the time;
> they are no longer executable entry points in the current repository. For the current implementation and cloud test entry points, see `docs/terminal-direct-integration.md`.

Updated: 2026-09-16. Test region: `ap-northeast-1`.

Latest constraints and validation: the user ruled out a self-hosted EC2 / Fargate resident relay. Client SigV4 HTTPS direct push to
`@connections` has completed a 100-sample EC2 comparison, with two-sided round-trip p50 21.21/23.06ms; the original path was
158.55/159.96ms. Beyond that, two-sided WS → Gateway HTTP integration → `@connections` now works end to end,
with the signature provided by the client, and a mismatch between the actual path encoding and the signed path encoding was fixed. Per-message traffic does not pass through Lambda,
and there is no dependency on a resident self-hosted service; the final two-sided WS 100-sample p50 was 34.28/35.74ms, versus 157.18/159.24ms for the baseline.
Real browsers and least-privilege authorization still need validation, and this cannot be treated as equivalent to the existing automatic WS pairing.
See `docs/terminal-connections-benchmark.md`. The earlier "does not pass through Lambda" candidate conclusions below are superseded by that document.

Follow-up same-API comparison between the local machine and EC2: on the local machine the new path p50 was 416.89/423.31ms, the original path 521.34/527.69ms;
across two EC2 rounds the new path p50 was 33.01–39.79ms. The local machine's IPv4 route to the target still went through `utun6` before and after,
so the 30-odd ms from same-region EC2 cannot stand in for the user's actual local latency. Details in section 7 of the document above.

Later update: a cross-EC2 standalone WSS relay comparison is complete, p50 1.64/1.87ms, versus the current Gateway + Lambda
at 147.46/143.90ms. For methodology, limitations, and VPN/EC2 re-tests see `docs/terminal-resident-relay-benchmark.md`;
that number is not the final latency for public-internet user terminals.

## Conclusions First

- The current client-to-API Gateway WS connection is persistent, but application messages still invoke Lambda one by one;
  it is not a resident application relay that pairs the Web and Bridge sockets and forwards directly.
- API Gateway supports non-Lambda integrations; it is wrong to say "all WS integrations can only use Lambda".
  However, the direct AWS service integration → `@connections` path tested here could not be deployed.
- HTTP integration + `CredentialsArn` does not equal automatic SigV4 signing. The later isolated runtime validation
  got client-provided signatures working, with Gateway HTTP calling the Management API to send back; see the latest validation document.
- AWS also offers managed pub/sub services such as AppSync Events and IoT Core, so bypassing per-message Lambda does not necessarily require WebRTC
  or a self-hosted server. AppSync Events was compared with real two-sided WS; this round showed no lower latency.
- A standalone WSS relay showed a clear gain in a cross-EC2 low-concurrency comparison, but the user has ruled out resident relay deployment.
  The experiment is kept as a performance baseline and is no longer treated as an implementation recommendation.

## 1. Current Implementation vs. Official Capabilities

Existing application data path:

```text
Web ──WSS── API Gateway ──Lambda / DDB / PostToConnection── API Gateway ──WSS── Bridge
```

Terminal input and output each go through one application forward. `$connect`, `$disconnect`, and `$default` currently point to the same
`AWS_PROXY` Lambda integration. Native WS Ping/Pong is not part of this application forwarding flow.

The AWS WebSocket integration documentation lists `AWS_PROXY`, `AWS`, `HTTP_PROXY`, `HTTP`, and `MOCK`.
Among these, HTTP integration calls an HTTP backend; it does not extend an established client WS as-is to a backend WS.
When the backend pushes to another client, the official interface is `POST /stage/@connections/{connectionId}`, which requires IAM/SigV4.
The client's existing Baton API Key cannot replace that signature.

The official Step Functions + WebSocket example does not prove that direct WS pairing exists either: the example first starts a state machine,
then Lambda sends messages to the client. It demonstrates service integration, not a low-latency shortcut for every terminal keystroke.

A real resident WSS application relay lets both Web and Bridge open outbound connections to it, and after identity and session binding are complete,
forwards messages through in-process routing. AWS ALB officially supports keeping a persistent client-to-backend connection after a WS upgrade.
But pairing the two clients, account isolation, backpressure, and disconnect handling must still be implemented by the relay application; ALB does not do this automatically.

## 2. Gateway Direct Integration Validation

Reproduction script: `test/server/ws_direct_integration_probe.py`.
The script creates a standalone API and a least-privilege temporary IAM role, and validates each case by calling the real `create_deployment`, without creating a public stage.
The role only allows access to `probe/POST/@connections/*` of that temporary API; the API and role are cleaned up afterwards.

| Configuration | Actual result |
|---|---|
| `AWS` → `execute-api:path/.../@connections/{connectionId}` | Deployment rejected: `AWS Service of type execute-api not supported` |
| `AWS` → `{apiId}.execute-api:path/...` | Deployment rejected: corresponding service not supported |
| `AWS` → `apigatewaymanagementapi:path/...` | Deployment rejected: corresponding service not supported |
| `AWS` → `execute-api:action/PostToConnection` | Deployment rejected: `execute-api` not supported |
| `AWS` → `apigateway:path/...` | Deployment rejected: corresponding service not supported |
| `HTTP` → the current temporary API's `@connections` URL | Deployable; runtime send-back not proven |
| The above `HTTP` configuration plus `CredentialsArn` | Deployable; not proven that it performs SigV4 signing |

The table above is an early deployment validation, not the final runtime conclusion. Later tests showed that adding only `CredentialsArn` returns 403 / missing authentication,
but when the client provides a SigV4 header or query matching the actual URI, the HTTP integration successfully sends back with 200.
For full runtime and latency results see `docs/terminal-connections-benchmark.md`.

Note: a successful `create_integration` does not mean it is deployable; testing only the configuration creation API is not enough to claim it works.
The errors above are measured results for this region, date, and specific URI, and are not generalized to "AWS integration is completely unusable".

The exploratory runtime test used a temporary `MOCK + IAM` `$connect`; the handshake returned 500 and never reached HTTP send-back.
This cannot count as evidence that HTTP send-back is unsupported. The final retained script explicitly validates deployment only, to avoid mixing test-infrastructure issues into the conclusion.

## 3. AppSync Events: Truly No Per-Message Lambda, but Slower This Round

It officially supports WebSocket publish and subscribe, and message broadcast does not require the user to deploy Lambda.
This round created a standalone Event API, a `terminal` namespace, and a short-lived API Key; no handler, data source, or Lambda was configured.
Only synthetic one-byte input/echo events were passed; no PTY was connected, and no real commands, files, or account data were sent.

Test path:

```text
Simulated Web ──WSS── AppSync Events ──WSS── Simulated Bridge
          ↑                                            │
          └────────────── verbatim echo ───────────────┘
```

Compared against the current Gateway + Lambda 128MB using the same machine, the same client library, and the same input/output business fields.
The order was Gateway → AppSync → Gateway, with 3 warm-ups and 30 measurements per group, and no artificial wait between samples.
Full two-sided round trips were measured with the local monotonic clock, without subtracting clocks from different machines.

| Pure-message two-sided round trip, ms | min | p50 | p95 | max |
|---|---:|---:|---:|---:|
| Gateway + Lambda 128MB, pre-baseline | 486.2 | 517.6 | 606.9 | 741.1 |
| AppSync Events, no per-message Lambda | 476.7 | 685.5 | 870.2 | 895.1 |
| Gateway + Lambda 128MB, post-baseline | 477.8 | 505.1 | 548.8 | 589.3 |

These numbers exclude PTY, xterm, and browser rendering, and must not be mixed with the keydown→DOM numbers in `terminal-latency.md`
as the same metric. The median local verbatim-echo time was about 0.006–0.008ms. Publish acknowledgment is not used as the measurement completion condition;
timing ends only when the target subscription actually receives the corresponding input/output.

The conclusion is limited to this round's network and configuration: AppSync can implement a cloud WS relay without per-message Lambda, but has no low-latency advantage.
This does not support claiming AppSync is slower in all regions, and there is no evidence attributing the extra time to any specific internal service mechanism.

One protocol detail was also found in practice: in the official example `data.event` is an array of strings, while the actually captured frame was a single JSON string.
The test decoder accepts both and has offline tests; the original synthetic data frames are kept in the private report.

Reproduction requires local `boto3`, `websocket-client`, and the Bridge configuration used for the current POC:

```bash
python3 test/server/ws_direct_integration_probe.py --run
python3 test/server/ws_managed_relay_bench.py --run --samples 30
python3 -m pytest -q test/server/test_ws_managed_relay_bench.py
```

Without `--run`, the scripts do not connect to AWS. The experiment requires permission to create and delete isolated resources; the existing business API is not used as the experiment deployment target.
The Gateway baseline creates temporary test client/Bridge connections and closes them at the end; it does not touch terminals the user is running.

This round's successful reports are in private system temp directories:
`terminal-direct-integration-probe-xz27h9il/report.json`,
`terminal-managed-relay-bench-r4ba61um/report.json`.

## 4. Change Scope and Next Choices

| Candidate | App changes/operations | Validated up to | Current assessment |
|---|---|---|---|
| Keep existing WS, raise Lambda to 512MB | Very small; no new protocol | Previous round compared with real PTY/browser; memory restored to 128MB | Minimal-change candidate; need to decide whether to accept the resource configuration change |
| Gateway direct AWS integration → `@connections` | Originally assumed very small | Direct integration deployment failed as above | No longer treated as a usable shortcut |
| Gateway HTTP integration → resident HTTP backend | Needs a new backend; still per-message HTTP/callback | Only official capabilities verified; no full performance test | Can replace Lambda, but is not direct forwarding between two WS |
| AppSync Events | Change terminal transport adapter and authorization; no self-managed server | Synthetic two-sided WS comparison complete | No latency advantage this round; do not migrate just because it is "Lambda-free" |
| IoT Core MQTT over WSS | New MQTT protocol, topic policies, and credential mechanism | Official docs only; not tested | Has a managed broker, but is not a direct replacement for the current JSON WS |
| Standalone resident WSS relay | New small service and deployment; can reuse the terminal event protocol | Later tested cross-EC2, p50 1.64/1.87ms; excludes ALB/public internet/PTY | Clear gain; next step is validating the real terminal loop |
| WebRTC DataChannel | New signaling, NAT traversal, TURN, and failure fallback | Not implemented or tested this round | Not the only way to bypass per-message Lambda |

If the standalone WSS relay is pursued, keep REST/the current WS management channel unchanged and let only terminal data choose the new transport:
reuse PTY, event sequence numbers, ACK, resizing, kill-process-on-disconnect, and leases; do not rewrite xterm.
First build the same synthetic two-sided message baseline, then measure real PTY/browser keydown→visible output, keeping a fallback switch.

Before the new relay goes live, short-lived session credentials, account/device/session authorization, and flow control must be added; this round's whole-API AppSync test Key
was only for the isolated synthetic experiment, cannot be copied directly to multi-tenant production terminals, and long-lived AWS credentials must not be distributed to the frontend.
A shared Key or an unguessable channel name must not be treated as complete authorization.

## 5. Official References

The following are the AWS official documents read directly in this round; documented capabilities, actual deployment validation, and performance measurements are kept distinct, with no reliance on forum speculation.

1. WebSocket integration types and HTTP backends:
   `https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-integration-requests.html`
2. `@connections` and IAM/SigV4:
   `https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-how-to-call-websocket-api-connections.html`
3. Integration API and the `CredentialsArn` definition:
   `https://docs.aws.amazon.com/apigatewayv2/latest/api-reference/apis-apiid-integrations.html`
4. Official AWS integration example (Step Functions, still calls Lambda to broadcast):
   `https://docs.aws.amazon.com/apigateway/latest/developerguide/websocket-api-step-functions-tutorial.html`
5. ALB native WebSocket support:
   `https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-listeners.html`
6. AppSync Events capabilities and authorization types:
   `https://docs.aws.amazon.com/appsync/latest/eventapi/event-api-welcome.html`
7. AppSync Events WebSocket handshake, publish, and subscribe protocol:
   `https://docs.aws.amazon.com/appsync/latest/eventapi/event-api-websocket-protocol.html`
8. IoT Core MQTT over WSS and authentication:
   `https://docs.aws.amazon.com/iot/latest/developerguide/protocols.html`
