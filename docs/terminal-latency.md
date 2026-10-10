# Remote Terminal Latency Validation and Optimization

> Historical experiment record: the temporary test scripts from this round were deleted as requested on 2026-09-16. The experiment paths and reproduction commands here only describe the method used at the time;
> they are no longer executable entry points in the current repository. For the current implementation and cloud test entry points, see `docs/terminal-direct-integration.md`.

Date: 2026-09-16. Scope: the remote POC on the `xterm` branch, using the existing Tokyo-region API Gateway WS / Lambda.
This is a measurement record, not a minimum-latency guarantee or SLA. All terminal input consisted of test characters/side-effect-free commands.

## Conclusions

- Removed the Bridge's fixed 8ms output wait; output is now coalesced and sent at the end of the current event loop, without waiting a fixed number of milliseconds.
- Moved input ACKs out of the display event ordering stream; a late ACK no longer blocks display of terminal output that has already arrived.
- Same-machine Bridge "input received → PTY echo sent" median dropped from about **10ms to 0.7ms**.
- The main cost is still the cloud round trip. Native WS Ping/Pong median is about **187ms**; a full remote input/echo involves
  browser→cloud→Bridge→cloud→browser, so one Ping cannot be treated as a full terminal echo.
- In the Lambda resource comparison, the fastest observed full echo was about **446ms**, with a median of about **480–493ms**;
  the original 128MB configuration after optimization had a median of about **604ms**. These are small samples under this round's network/machine conditions, not theoretical limits.
- **128MB has now been restored**; cloud memory was not permanently increased, the architecture was not changed, and identity/connection ownership checks were not weakened.
  If a resource change is acceptable, 512MB is a follow-up candidate; 1024MB showed clearly diminishing median gains in this test, and long-term cost cannot be inferred from it.

## Method

`test/bridge/terminal-latency-bench.mjs` creates a separate temporary Bridge device connection each time, reuses the real
`createTerminalRemote` and PTY, loads the existing xterm page in real Chrome, and goes through the actual cloud WS.
It does not occupy the test terminal the user is working in, and does not run install/deploy scripts.

The shell is an interactive Bash without user startup configuration, using `read -r -p 'BENCH> '` to receive characters one at a time. Each round has 3 warm-ups,
followed by 30 sequential keystrokes; the next character is sent as soon as the previous one is visible, with no artificial interval between samples.
Statistics use nearest-rank percentiles, and min is the observed minimum; initial connection setup and shell login configuration time are excluded from keystroke statistics.

Captured and broken down:

1. Browser actual keydown → WebSocket.send.
2. WebSocket.send → same-machine test Bridge receives input.
3. Bridge receives input → output sent (including PTY and coalescing scheduling).
4. Bridge output sent → browser receives raw WS frame.
5. Raw frame received → ordering adapter delivers to page.
6. Page delivery → character appears in xterm DOM.

The browser and Bridge both ran on the same Mac, using `performance.timeOrigin + performance.now()` for
same-machine segment observation; clocks from the client and AWS (different machines) were never subtracted directly. AWS segment timings independently use
`time.perf_counter()` and serve only as processing-stage observations, not as one-way network latency.

The test kept the full HAR, continuous CDP network/WS events, unmodified application-layer frames, and segment reports; recording was not
cleared on page navigation. This standalone page has no messages REST requests. Baseline frames were replayed through the real `RemoteTerminalSocket`
in tests before the ACK ordering change was implemented.

**HAR/CDP contain connection URLs and auth headers; they are stored in a permission-restricted local temp directory, and are not committed or uploaded.**
The sampled frames in `report.json` contain only test terminal content; do not use this recording method in a way that unintentionally records secrets in production terminals.

## Measured Results

Unit: ms; 30 formal samples per full terminal configuration, plus 3 warm-up samples.

| Configuration | Min | p50 | p95 | Max |
|---|---:|---:|---:|---:|
| Original implementation, Lambda 128MB | 517.2 | 616.2 | 715.6 | 759.8 |
| No fixed output wait + independent ACK, 128MB | 523.4 | 603.9 | 747.4 | 3597.7 |
| Same code, 512MB temporary comparison | 447.0 | 493.2 | 660.6 | 939.3 |
| Same code, 1024MB temporary comparison | 446.2 | 479.7 | 558.9 | 619.9 |

The 128MB optimized round had one long-tail sample of about 3.6 seconds, which was **not excluded**. For that sample the Bridge→browser segment was about 3299ms,
PTY/coalescing about 0.7ms; the corresponding server-side processing timing was about 686ms. Time not covered by processing timing may also involve invocation scheduling,
initialization, and network, and cannot be attributed entirely to cold start without additional evidence. A small-sample p95 cannot replace long-term long-tail acceptance.

Native control-frame Ping/Pong was measured separately 20 times: min **184.9**, p50 **186.9**, p95 **193.5**, max **194.8ms**.
It does not include PTY, terminal rendering, or the full bidirectional forwarding of application messages; it is only used to observe the round-trip overhead of the current WS path.

### Local Code Segments

| Stage | Original p50 | Optimized 128MB p50 |
|---|---:|---:|
| keydown → send | 0.1 | 0.1 |
| Bridge input → PTY output sent | 10.0 | 0.7 |
| Browser ordering wait | 0.1 | 0.1 |

The median ordering waits are all small, but the baseline measurements showed cases where output arrived first and a preceding ACK arrived late, adding extra waits of about
12ms and **87ms**; after the change, the maximum ordering wait in this round was about **0.2ms**. No fake local character echo was used to mask network latency.

The xterm DOM rendering segment in these headless browser tests with HAR/CDP recording had a median of about 24–35ms, with frame-scheduling jitter.
This round does not modify xterm private internals, does not call the deprecated `writeSync`, and does not treat DOM time as display pixel presentation time.

### Server-Side Segments

Only test sessions with `profile: true` emit `[terminal-timing]` structured timing; ordinary sessions do not log it.
Logs contain terminalId, event kind/sequence number, and duration, but no input, output, or API Key.
The following are per-stage medians from test-related logs, including setup/warm-up, so they should not be summed item by item to replace the 30-sample total latency.

| Stage | 128MB | 512MB | 1024MB |
|---|---:|---:|---:|
| Upstream connection identity lookup | 12.9 | 3.0 | 3.2 |
| Upstream device routing lookup | 40.0 | 4.4 | 4.6 |
| Upstream PostToConnection | 39.7 | 13.3 | 14.5 |
| Upstream handler total | 85.1 | 21.2 | 22.1 |
| Downstream target connection lookup | 37.3 | 3.7 | 3.9 |
| Downstream handler total | 73.9 | 20.6 | 19.6 |

The tests show that for this workload, server-side time drops significantly at 512MB, and 1024MB does not bring a further drop of similar magnitude.
The groups are sequential comparisons, not strictly randomized controlled experiments; changes in network, warm instances, and machine load also affect results.
AWS officially states that memory configuration also affects CPU allocation; original source:
`https://docs.aws.amazon.com/lambda/latest/dg/configuration-memory.html`.

## Implementation Changes and Invariants

- `bridge/terminal-remote.mjs`: `setTimeout(flush, 8)` changed to `setImmediate(flush)`; full chunks and exit still flush immediately.
- ACKs use `eventSeq: 0` and a cumulative `clientSeq`, and do not consume display event sequence numbers. Other output/resize/exit events remain strictly ordered.
- Web and Server remain compatible with the old ordered ACK; the new independent ACK still goes through account, device, connection, and clientSeq checks.
  Output must not be allowed to use eventSeq 0 to bypass ordering.
- Heartbeat, disconnect/reconnect, missing-sequence timeout, and lease reclamation are health/failure handling, not waits on the normal input path; they are kept.
- The 28KiB frame limit, Base64 byte transport, queue cap, and single-connection ownership are kept; security is not weakened in exchange for numbers.
- Only the terminal module and optional timing entry point of `Baton-ws-handler` were incrementally deployed; the existing old terminal routes are still kept.
- Updated WS code SHA256: `+arVrSMgCIX8JEjpodhIufhRHGT3PP9p5lJml88aiAE=`.
  Lambda memory was restored to **128MB** after the comparison; CloudFormation default specs were not modified.
- The standalone test Bridge was restarted only after confirming it had no active PTY child processes, so the same test URL uses the new code; the existing production Bridge was untouched.

## Reproduction

WS Ping only, without depending on browser test libraries:

```bash
node test/bridge/ws-rtt-bench.mjs --run --samples 20
```

The full real-browser test requires local Playwright and Chrome, with Vite running on 5173; `PLAYWRIGHT_MODULE`
can specify the absolute module directory of an installed Playwright (so no local path is hard-coded in the repository):

```bash
node test/bridge/terminal-latency-bench.mjs --run --samples 30 --label comparison --profile
```

`--echo` is an optional pure-byte echo comparison that does not start a shell and must not be passed off as full PTY validation; all tables in this document are real PTY.
Without `--run`, the script only prints usage and does not connect to AWS. Reports are written to a newly created private temp directory.

Replay a captured report:

```bash
TERMINAL_LATENCY_REPORT=/absolute/private/report.json node --test test/frontend/terminal-remote-transport.test.mjs
```

This replay test targets the baseline report with ACK blocking; ordinary automated runs do not read local private capture files.

All recording directories from this round are under `/var/folders/9g/xkkjxhjd1mn3dt2p1y0sqymc0000gq/T/`:
`terminal-latency-baseline-mpCxND`, `terminal-latency-immediate-128-wNSPv6`,
`terminal-latency-memory-512-lGIzvw`, `terminal-latency-memory-1024-2CSlo4`.
The deployment backup and original memory configuration are in `terminal-latency-deploy-1itycrvh`; before restoring code, check whether a newer deployment already exists.

## Next Steps

There is no longer any millisecond-level fixed echo wait, so further blindly shrinking timers has limited benefit. The user first decides whether to adopt 512MB;
if the goal is still the earlier p50≤150ms, a closer deployment region or a persistent forwarding service needs separate review, validated on a real network.
It cannot be promised that just changing servers will hit the target, and fake local echo should not be used to mask the real remote state.

Later on 2026-09-16, Gateway direct integration deployment validation and a synthetic two-sided WS comparison of AppSync Events were completed;
see `docs/terminal-relay-options.md`. Direct `execute-api` AWS integration was rejected by the deployment API;
although AppSync does not use per-message Lambda, its pure-message round-trip p50 this round was 685.5ms, versus 517.6/505.1ms for Gateway,
so it has no low-latency advantage. This set excludes PTY/browser rendering and cannot be compared directly with the keydown→DOM metrics above.

Later the same day, EC2 was used instead for a stable-network comparison, and a cross-host test of a standalone WSS relay was completed.
Latest results are in `docs/terminal-resident-relay-benchmark.md`: original path about 144–147ms, relay about 1.6–1.9ms,
both synthetic two-sided message round trips after warm-up, not the final user page latency. Earlier local-machine data cannot be interpreted as pure cloud runtime overhead.
