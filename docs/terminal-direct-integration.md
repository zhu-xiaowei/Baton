# Header-Signed Direct Forwarding and Project Shared Terminals

Updated: 2026-09-18. Multiple terminals per project are implemented; production releases use `server/install.sh --region ap-northeast-1 --stack Baton`.
Multiple terminals still reuse the existing Header-signed direct forwarding and need no new cloud API or always-on EC2 / Fargate relay.

## Startup and Fast-Return Optimization (Pending Coordinated Release)

- Returning to the page keeps one synced terminal instance and its connection for at most 60 seconds; a hidden page still processes output and ACKs, but does not accept input, steal focus, or change the shared size.
  When the account, server, and project are the same and the connection is still valid, the original instance is restored directly. It is released on expiry, app backgrounding, going offline, account switch, or connection error, and re-entry goes through full recovery.
  Nothing is cached while connecting, syncing, or running a management operation; releasing the connection still does not end the Shell in the Bridge.
- Config is cached in memory per server and API Key, and concurrent requests are shared. If a same-account app control WS already exists it is borrowed, without creating another control connection;
  closing the terminal only releases its own attachment and does not close the main app WS. The same control connection is not borrowed again until the server's close confirmation is received.
- The Bridge declares support for startup parameters via `terminalStartup=1`. The App's first `terminal_direct/open` carries the selected sessionId and size,
  which the server validates and delivers with the offer; once the data channel is authorized, the Bridge attaches and sends the screen directly, and the App no longer sends a second data open.
  When either an old server or an old Bridge does not support this capability, the original data open flow is kept and no Shell is created early.
- The server first completes ownership checks on all four connection records, then requests the two STS credentials for App / Bridge in parallel; it activates only if all succeed and the state is still valid.
  API Key, join token, data API isolation, STS permission scope, HMAC, and session sequence numbers are unchanged; data is still forwarded directly through the HTTP integration.
- Snapshots are sent with at most four unacknowledged chunks; once the last chunk is queued for sending, the ordered synced and cached deltas are sent immediately.
  The frontend still waits until all snapshot chunks are actually written to xterm before processing synced. render_ack still releases in-flight bytes and advances the large-snapshot window,
  but no longer additionally blocks input unlock for small snapshots; overflow and disconnect protection are retained.

Frontend, Bridge, and server changes must be released together to get the full cold-start benefit; updating only the frontend is enough to validate fast return, config caching, and control connection reuse.
A production Bridge restart ends existing PTYs; confirm that work in the terminal is saved before releasing.

### Validation for This Change (2026-09-18)

- The local new frontend connected to the not-yet-updated online service and the production Bridge, confirming that the old-protocol fallback works. In the final five fast-return rounds there were no config requests
  and no new WS; click-to-input-state recovery was 1.1–5.1ms, and the first requestAnimationFrame callback was 41–79ms.
  The client was a Chrome mobile viewport; the animation frame callback is not a measurement of paint completion or the iOS keyboard animation.
- Two old-protocol startups with main app control connection reuse took 3611ms and 2971ms; after closing the terminal, the main connection was still usable for the next open.
  These are not cold-start results after a full deployment of the new server / Bridge. Full cold start still needs re-testing after the coordinated release.
- Isolated validation used a real PTY and the current DirectDataChannel, confirming no second data open under the new protocol and normal fallback under the old protocol;
  small snapshots send synced without waiting for render ACK, large snapshots are still bound by the four-chunk window, and exiting only disconnects the attachment without ending the Shell.
- Cache validation covered output and ACK while hidden, rejection of hidden input, 60-second expiry, disconnect, background, offline, page exit, and account change.
  Server validation covered checking ownership of all four connections before parallel STS, rejecting cross-account connections, startup parameter validation, and capability negotiation.
- Account / server boundary review passed: a change or logout closes the main connection and terminal cache and clears the WS address from memory and local storage;
  late-arriving old config does not restore a connection, and the control connection is not borrowed when the address, API Key, or role does not match. Settings with the same identity do not break existing connections.
- Before commit, all 806 tests passed and the production build passed; only pre-existing warnings, and no new repository test files were added.
- The iOS simulator had concurrent page operations, so the keyboard regression result is not treated as final acceptance; the original tap-to-focus logic is unchanged, and the cache does not additionally toggle the textarea read-only state.

### Two-Terminal Switching Re-Test (2026-09-18)

- A Chrome mobile viewport connected to the same production Bridge through the existing online data channel, alternately testing the old online page and the local new page,
  nine switches each. Old: mean 944ms, median 942ms; new: mean 949ms, median 920ms; neither created a new WebSocket.
  This measures selecting a terminal until the input control unlocks, excluding the soft keyboard animation; this round did not reproduce a persistent frontend switching performance regression.
- New-version mean breakdown: click to selection request sent 2ms, request to snapshot arrival 491ms, snapshot processing to ACK 4ms,
  ACK to synced 448ms, final unlock 5ms. The first non-alternating samples also showed 6410ms / 8841ms long tails,
  mostly in the request-response and acknowledgement-wait stages; not further localized to a specific network or remote-processing step.
- The production Bridge was still running the old completion condition `snapshot.acked === snapshot.chunks`; local source has been changed to send the ordered synced once all chunks
  are queued for sending. The 60-second page cache only optimizes exit and re-entry; it does not cache the live screen of each unselected terminal.
- Isolated real-PTY validation compared the two completion conditions, simulating 200ms data latency in each direction between App and Bridge, six switches each:
  old condition 809–820ms, new condition 407–413ms; Bridge processing about 0.6–6.1ms. Both conditions correctly restored their respective screens,
  kept the original two Shells, and switching created no new connections. This is a controlled-latency validation, not an online measurement of the new Bridge.
- This round did not update or restart the production Bridge; the actual switching benefit still needs re-testing after saving terminal work and updating the Bridge.

## Project Shared Terminal (Current Implementation)

The user chose that all pages can type, with no single-writer lock, takeover button, or input prediction. Usually only one person is operating;
if two pages type at the same time, the Bridge orders each by its contiguous sequence numbers and writes input into the same PTY in processing order,
with no promise of treating a whole command as a cross-device mutually exclusive transaction.

### Pages and Sessions

- A Terminal icon is added to the top right of each project's session list, lazily loading `web/js/terminal.js` and xterm.
- On the same Bridge, the same normalized real directory keeps at most 5 Shells; different terminals have isolated processes, directories, and screens, and all pages selecting the same
  `sessionId` can still type simultaneously and receive synced output. The list is maintained by the Bridge, not numbered independently by each browser.
- Names are Terminal 1-5, using the smallest free number; after closing, names are reused but `sessionId` or `epoch` are never reused.
- On first entry with no terminal, one is created atomically; when terminals exist, the selection in the page's sessionStorage is restored first, otherwise the first one is selected.
  On first entry or reconnect after a Bridge restart with no terminal, a default terminal is also created, and 1/5 is shown after the list syncs.
- Returning to the page keeps a valid connection briefly; closing the page, cache expiry, or network disconnect only detaches without ending the Shell; a later-joining page restores the screen first, then receives live output.
- The page Reset is removed; the right side uses a dropdown button labeled with the current terminal name; the top of the overlay shows the count and a create button, and each row supports select and close.
  Close reuses the confirmation dialog, terminates the selected terminal, and switches all its viewers to the first remaining one; other terminals and viewers are unaffected.
  When only one remains, close becomes restart: the replacement Shell is started successfully first, then the old process is stopped, the smallest free number is reallocated from 1, and the ID / epoch are changed;
  all viewers restore the new screen. If the new Shell fails to start, the original terminal is kept and the 0/5 empty state is never entered.
- The overlay width is constrained to the viewport, it supports scrolling at reduced heights, and each action row/close/create button is at least 44px; Escape, Tab, and arrow keys are supported.
- Input is bound to both `sessionId` / `epoch`; old input after switching or closing never reaches another Shell. When a management operation's result is uncertain,
  only reconnect and restore the list; create/close operations are not automatically resent, to avoid duplicate execution.
- The bottom shortcut bar for Esc, Tab, Ctrl, arrow keys, etc. is temporarily removed, keeping normal keyboard input; mobile interaction will be adapted uniformly later.
- The title bar reuses the single-row height and project pill of Git Changes / Project Files; Connected, connection count, or a green dot are not shown.
  During connecting, syncing, and automatic retry, the pill border loading is reused, and the normal pill is restored on success; a notice is shown only for errors or Shell exit and similar cases.
- A newly joining page does not immediately change the shared size; on actual input, focus, or a size change of the active page, that page's size is adopted and broadcast to the other ends.
- Only macOS / Linux for now. A Bridge restart or exit ends the PTY; no claim of tmux-style cross-process recovery.

### Connection, Authentication, and Events

1. The main Bridge control WS declares the capability via `terminal=2`, and the server stores `terminalProtocol=2`.
2. Each page borrows an available app control connection or creates a dedicated one to send `terminal_direct/open`, containing device, projectHash, and a random terminalId.
3. Lambda validates same account, a unique and online device, and main Bridge capability. The Bridge control connection stores multiple attachment IDs;
   each attachment exclusively owns its own two data-side connections, and one app control connection binds at most one attachment at a time. Each attachment has its own join token, STS, and HMAC key.
4. The data business action is `terminal_shared, v1`, the outer layer is still `terminal_direct_frame`, continuing the Header-signed HTTP integration.
   `terminalId` is the page attachment ID; the `sessionId` delivered by the Bridge is the shared PTY identifier.
5. Input events: open, input, resize, heartbeat, render_ack, detach, create_session, select_session, close_session;
   output events: ready, snapshot, synced, output, resized, peers, exit, error, ack, sessions, session_result.
   Business frames are bound to device, projectHash, terminalId; Shell input is additionally bound to sessionId and epoch.
6. Each page has its own `clientSeq` / `eventSeq`. ACK's eventSeq is 0 and does not participate in output ordering; input sending does not wait for per-character ACK.
   ready / snapshot / synced form one snapshot transaction; output is applied in order after the snapshot completes.
7. When the server closes an attachment, it only releases that ID from the Bridge's set and does not clean up other pages. A Bridge control disconnect closes these
   data connections, but the local PTY and screen mirror are kept; after the main control connection recovers, pages re-attach to the same project.
8. The standalone `terminal_poc` validation entry is unchanged; project pages do not use its "kill PTY on disconnect" semantics.
9. `open` may pass `sessionId`; management events carry `requestId`, select/close carry the target `sessionId`,
   and create carries cols/rows. The Bridge only allows access to sessions under the authenticated project's normalized directory, and processes in page clientSeq order.
   Creation/capacity checks for the same project complete synchronously, so even with multiple racing pages a 6th cannot be created.
10. `sessions` broadcasts `{limit:5,sessions:[{id,name,exited}]}`; `session_result` returns
    `{requestId,error?}`. Switching reuses the original data channel and resends the snapshot; a project always keeps at least one terminal.
    No old/new version compatibility or capability negotiation; frontend and Bridge must be updated together; the reset event of the project shared terminal is removed.
    Cloud authentication, data integration, IAM, and per-frame signing are all unchanged.

Credentials still use the original account API Key. The API-level IAM restriction and the HMAC security boundary are unchanged, see below;
the shared terminal does not constitute an independent multi-tenant security upgrade and should not be directly exposed to untrusted tenants.

### Bridge Screen, Limits, and Flow Control

`bridge/terminal-shared.mjs` uses node-pty 1.1.0, @xterm/headless 6.0.0, @xterm/addon-serialize 0.14.0.
The main Bridge still keeps the existing message and project handling logic; the shared terminal initializes on demand, and automatic upgrade is deferred while there are active Shells.

| Item | Current limit / behavior |
|---|---|
| Per project | At most 5 terminals (including exited but not yet closed terminals), enforced by the Bridge |
| Same Bridge | Total protection cap of 20 terminals and 16 page attachments; when the total is insufficient, only exited records in other unviewed projects are cleaned up |
| Input | Raw bytes per frame ≤4 KiB; a single page input / paste ≤64 KiB, rejected entirely if exceeded |
| Output | Raw bytes per chunk ≤16 KiB; final signed WS frame ≤28 KiB |
| Mirror | 1000 lines of scrollback; broadcast immediately after entering the xterm mirror, with no artificial output-coalescing wait |
| Snapshot | At most 4 MiB, 16 KiB chunks, 4-chunk window; on overflow scrollback is dropped first, with explicit notice of history truncation |
| Consumption ACK | Snapshots are acknowledged per chunk after parsing; live output is acknowledged every 16 KiB or at most 100ms, affecting only flow control, not delaying display |
| Slow page | Per-page unacknowledged / pending output cap of 512 KiB; overflow disconnects only that page, without blocking other devices or killing the Shell |
| Mirror backpressure | Pause reading the PTY when queued >256 KiB, resume at <64 KiB, 1 MiB hard cap |
| Lifecycle | Page heartbeat 10 seconds; the Bridge releases the attachment after more than 45 seconds without messages; PTY kept |
| Input / output gaps | Bounded reorder queue; if a gap is still not filled after 10 seconds, disconnect with an explicit notice, then recover via snapshot |

Terminal queries are uniformly answered by the Bridge's authoritative mirror. The browser suppresses automatic DA, DSR, DECRQM, and DECRQSS replies,
preventing multiple pages from replying repeatedly to Vim's mode queries, which Vim would treat as ordinary keystrokes. Color queries are answered by the Bridge using the default terminal theme.
This does not cover all optional VT extensions; full window operations, palette queries, etc. still need separate evaluation, and full compatibility cannot be claimed.

### Validation Record

- This five-terminal validation: real PTY covering concurrent default-terminal creation, five-cap races, session/project isolation, screen restore on switch,
  cross-page close, name reuse without ID reuse, old-input interception, natural exit and list sync, and process retention on disconnect.
- A real browser connected through the deployed Header direct forwarding to an isolated test Bridge, validating dual-end input, create/select/close, close cancel,
  selection restore on page return, the fifth-terminal cap, and re-creation from the empty state; cloud interfaces and the running main Bridge were not changed.
- Mobile layout checks covered 320px, 390px, landscape, reduced viewport, and native safe-area; the title bar stays 44px (68px with a 24px
  inset), the overlay does not exceed the viewport, and menu actions are at least 44px. After switching on desktop, input focus is restored; on mobile the soft keyboard is not proactively opened.
- read prompts without newline and cross-end Enter work; on mobile, switching away from Vim and back allows editing, saving the file, and returning both sides to the Shell.
  Acceptance is based on file contents and subsequent Shell output, not on Vim's brief written notice; the full HAR/WS is kept outside the repository,
  and the check of that notice also replayed 527 frames through the actual frontend to confirm screen restore after save.
- This round, 371 frontend checks and 5 packaging checks passed, and the production build passed; no new repository test files were added.

The following is the historical validation record from the earlier single-terminal phase (Reset and shortcuts in it have since been removed from the new UI):

- Private temporary validation covered a real PTY: dual-end input, shared environment, directory isolation, process retention when one end closes, all-end Reset, old epoch
  input rejection, synced resize, Vim alternate screen restore and save, large snapshot chunking, and re-attach after Bridge control disconnect.
- Passed dual-end and mobile-size validation via real Chromium → deployed API Gateway Header integration → isolated local Bridge.
  Validated the project entry, read prompt without newline, Enter from the other end, restore after return, Reset confirm / cancel, Vim save from a third end, and shortcuts.
- Multi-page Vim checks found duplicate DECRQM replies; the full HAR and all WS frames were kept and replayed through the actual frontend, then fixed, and the re-test passed.
- Foreground/background switching once triggered a project list refresh that closed the terminal overlay; likewise the record was kept, replayed, and fixed, and the terminal page is kept when returning to the foreground.
- 350 existing frontend / packaging tests passed, 37 existing direct-forwarding and server compatibility checks passed, and the production build and fresh Bridge dependency install passed.
- The validation programs and raw records containing short-lived credentials are only in a private directory outside the repository; no new repository test files were added.
- Mobile-size Chromium is not the same as real iOS / Android soft keyboards; Chinese IME, background switching, and virtual keyboards still need real-device testing by the user.

### Deployment Scope (2026-09-17)

Frontend and Bridge must be updated together; the old single-terminal protocol is not compatible. The install script adds the shared protocol file to the frontend build context,
and also packages the terminal module needed by the API runtime; WS code is handed to CloudFormation under a unique S3 key for update and rollback, avoiding
temporarily overwriting the running handler with placeholder code. A CloudFormation update failure now errors out directly instead of falsely reporting success.
The following is the deployment record of the earlier shared single terminal; results of this release are in the commit and deployment logs.

- The cloud control interface was deployed incrementally, keeping the old Lambda files and original business routes; terminal data continues through the Header HTTP integration.
- The production homepage project entry and terminal assets were deployed to CloudFront, and the homepage cache was refreshed; only static assets were layered on, without replacing original API business code,
  and landing / setup, API integration, and IAM policies were checked as unchanged.
- The local `MacBook-Pro` main Bridge had dependencies updated and was restarted, and the control record declares `terminalProtocol=2`. The install directory keeps the original config
  and the old pipe-route compatibility layer, with terminal core files matching this branch; the standalone old POC Bridge was not restarted.
- The local install is marked `TERMINAL_BUILD=shared-20260917`. No global Bridge auto-update package was released this time, keeping the published
  `BRIDGE_VERSION=1.0.0-term2`, so other machines will not auto-upgrade without validation.
- The production CloudFront page connected to the local main Bridge, with actual `pwd` being this project directory; independent browser contexts at desktop and mobile sizes
  shared the same sessionId, both ends could type and receive output, and after all pages exited and re-entered the same Shell and screen were restored.
- A real Shell may first load the user's login config; `Connected` means the channel and screen are synced, not that the Shell has shown a command prompt.
  Automated command acceptance types after the initial prompt appears, and does not treat an input ACK as proof that the command executed.

The following sections keep the 2026-09-16 exclusive POC design and historical measurements; for session lifecycle, this section is authoritative.

## Assumptions Corrected by Measurement

**API Gateway ManageConnections cannot use an actual connection ID for IAM Resource isolation.**
Writing `/POST/@connections/<specific ID>` in the STS session policy returned 403 in testing; AWS's authorization resource is
`/POST/@connections/{connectionId}`. Separating control / data WS within the same API is still not secure enough: the original Baton API's
wildcard POST permission cannot be given to the browser, otherwise it could inject events into chat / Bridge control connections.

Fixed-target Header signing + `UNSIGNED-PAYLOAD` also failed in testing: changing the body returned InvalidSignatureException.
Earlier latency tests only proved that Header forwarding is feasible, not that per-connection IAM isolation is feasible; this document corrects that design assumption.

## Current Architecture

```text
Control plane: Web ── original Baton WS / Lambda ── Bridge
                 identity, pairing, STS, renewal, close

Data plane: Web xterm ── standalone Terminal Data API ── Bridge PTY
                        Header SigV4 HTTP integration
                        POST @connections
                        no per-message Lambda
```

- A new AWS-managed WebSocket API is added, allowing only the terminal_data role and carrying no chat, tool, or control connections.
- Each end has one original-API control WS and one new-API data WS; the old experimental direct-forwarding route is moved off the original API.
- STS is valid for 900 seconds and only allows `POST /v1/@connections/*` on the standalone data API, not GET / DELETE or the original API.
  **This is an API-level permission, not a per-connection permission.**
- Each terminal additionally has a 256-bit random frameKey, delivered only from the trusted control plane. Data bodies must pass the session HMAC-SHA256,
  then terminal ID, device, direction, type, and sequence number are checked, before being handed to the PTY / xterm.
- Wrong-MAC, unsigned, or other-session data is ignored directly; it cannot execute in the Shell, nor change control state with a fake ready / closed.
- The original API Key / account hash account model continues to be used; no claim of having refactored the whole product identity system.

### Security Boundary

A valid STS can still send junk traffic to other connection IDs on the standalone data API. MAC prevents cross-session command / output injection,
**but cannot eliminate bandwidth abuse, resource consumption, or denial-of-service risk**. Bounded queues / frame-drop timeouts protect memory, but do not guarantee availability under attack.

This currently suits a controlled local POC and should not be directly exposed to untrusted multi-tenants. If server-side per-session send ACLs, tenant-level quotas, and
abuse resistance are needed, choose a managed service that supports topic / channel ACLs, or keep server-side per-message authorization.
Expanding this role's permissions to the original Baton API is forbidden, and HMAC must not be described as IAM per-connection permission.

## Initialization and Teardown

1. Web sends terminal_direct/open over the original API's app control connection, explicitly selecting the test Bridge.
2. Lambda validates same account, unique device, xterm-direct-1 version, and takes a conditional lock on both control records, one POC per Bridge.
3. Create a UUID, two distinct join tokens, and a frameKey; DDB only stores token hashes. The frameKey is stored as a short-lived session secret in
   the existing encrypted DDB, deleted on close, with TTL as backstop; never logged. The STS secret is not stored in DDB / localStorage.
4. Both ends receive the offer / data endpoint from the trusted control plane, connect to the new API, and join. Lambda checks the real API endpoint,
   role, account, token, 45-second deadline, and conditionally binds the data connection ID.
5. After both ends join, STS, frameKey, and their own and peer data IDs are delivered only over the original control connection; the local PTY is created only after Web sends open.
6. Web renews via the control plane at least every 5 minutes, verifying all bindings and keeping the same peer / frameKey; Bridge control heartbeat is 60 seconds.
7. When any connection closes, the PTY is destroyed, the conditional lock released, the data WS closed, and the frameKey deleted; clients stop proactively before credentials expire.
   No recovery of disconnected PTYs, no input replay, no automatic fallback to Lambda.

## Protocol and Limits

- Control: terminal_direct, v1, open / join / renew / close.
- Data route: terminal_direct_data, HTTP POST integration, no CredentialsArn.
- Outer JSON: target, body, authorization, date, token.
- body: `{payload: "exact JSON string", mac: "HMAC-SHA256 hex"}`, the whole body also participates in SigV4.
- payload: terminal_direct_frame, v1, terminalId, device, message; message keeps the terminal_poc sequence numbers / ACK0.
- The Bridge overrides the client's replyConnectionId, using the peer data ID bound by the control plane.
- Single input 4KiB, output chunk 16KiB, final WS frame including MAC / signature no more than 28KiB; control request 8KiB.
- Pre-authorization cache and receive-verification queue 256KiB each, signed send queue 1MiB, PTY pending output 1MiB, total output cap 16MiB.
- Data heartbeat 10 seconds, ACK deadline 30 seconds, Bridge lease 45 seconds; not a finished product for unlimited output / long-connection recovery.
- Signing and MAC verification use a bounded sequential Promise queue; no new fixed flush wait was added.
- Web / Node share WebCrypto; SigV4 uses the Gateway's actual raw callback path, keeping the botocore fixed-vector test,
  to avoid double-encoding a trailing `=` / `%3D` in the connection ID.

## Entry Point

Open the project shared terminal via the Terminal button on the production App's project files page or at the top of a Session.
The early standalone POC page and its test Bridge startup script have been removed, and the build no longer includes a separate self-test entry.

## Input Echo and Mobile

On 2026-09-16, as requested, the input preview component, toggle, and overlay were removed; desktop and mobile uniformly use real PTY echo.
Input is sent immediately without waiting for Enter; only data returned by the remote PTY may be written to xterm, and ACK does not control character display.
Ordinary text, backspace, or Enter are no longer predicted, and local display is not used to mask public-network latency.

Mobile will next validate composition / beforeinput, soft-keyboard backspace, and paste, then handle viewport / fit, focus retention,
and the Esc / Ctrl / Tab / arrow-key toolbar. This round added no mobile usability features.

## EC2 Real PTY Echo Measurement (2026-09-16)

Ran Node v20.20.2 / Linux x64 inside a temporary Docker container on the existing `test-ec2-ap`, with the same
`node-pty@1.1.0` as the project. No system build tools were installed and no always-on service was added. Client and Bridge were both on that EC2,
using the deployed Header-signed WS / HTTP integration and the real frontend transport ordering code; the PTY ran `cat` with line buffering disabled
and kernel echo disabled, timed by the real bytes received. Timing excludes SSH startup, browser painting, or local VPN.

| Scenario | Samples | p50 | p95 | Max |
| --- | ---: | ---: | ---: | ---: |
| EC2 in-process direct write / read of real PTY baseline | 60 | 0.064ms | 0.103ms | 0.248ms |
| EC2 → cloud Header forwarding → EC2 PTY → cloud forwarding → EC2 | 180 | 34.10ms | 56.59ms | 142.76ms |
| Same as above, one character every 8ms continuously | 186 | 38.13ms | 133.68ms | 157.04ms |

Cloud data comes from three sampling rounds in the same session; each round first warmed up 8 times, then ran 60 per-character round trips and 62 continuous inputs.
Percentiles in the table are computed from the merged raw samples, not by averaging per-round percentiles; long samples were not excluded.
Continuous input still has a long tail of about 100–157ms, so the 34ms median cannot be taken as a no-stutter guarantee.
This result isolates the local proxy network, but is not equal to end-to-end browser latency after the user disables VPN, nor a local SSH baseline.
The actual effect on the user's network must be validated via the CloudFront page above with VPN disabled.

The raw report and full WS frames are kept in a private acceptance directory outside the repository; raw frames contain credentials and must not be committed or shared.

## Deployment Boundary

`python3 scripts/deploy-terminal-direct.py --run` explicitly deploys incrementally and does not execute by default.
It uses the online template / ZIP as the base, keeping the old pipe module and other routes. It only adds terminal-related resources and patches WsHandler;
WsIntegration only allows reference updates with unchanged template content. Moving the three experimental HTTP integrations / routes to the new API is allowed.

The code package is placed as a unique encrypted object in the existing private bucket, CloudFormation updates Code and environment variables, and SHA-256 is verified after deployment.
No new bucket is created, no permissions are opened, and the whole install.sh is not run. Code objects are kept for template references.
When the old template is a placeholder ZIP the first time, automatic rollback is forbidden to avoid overwriting online code; subsequent real S3 code versions support safe rollback.

## Validation and File Cleanup

On 2026-09-16, as requested, the 23 tests, unit tests, and temporary measurement scripts added by this batch of changes were deleted, and newly added assertions to the original packaging tests
were reverted; the project's original tests are outside the scope of this cleanup. Historical measurement results are kept in the design document, and the experiment runners are no longer kept.
This round's build check uses `npm run build`; one-off cloud and EC2 acceptance tools are only in a private temporary directory outside the repository.

Browser checks saved the raw full HAR / WS frames and screenshots to a private temporary directory. Raw records contain API Key / short-lived credentials
and must not be printed, committed to the repository, or used as public attachments. Reports list only behavior and statistics.

Coverage: real xterm → HTTP integration → Bridge PTY, read prompt without newline, ANSI, Chinese, Enter, Ctrl-C, resize,
Vim save, second-page occupancy protection, refresh teardown, keystroke echo latency, and IAM denial on the control API plus data MAC anti-injection.

### Previously Completed Validation (Historical Record)

- CloudFormation `UPDATE_COMPLETE`; the original API has no terminal_direct_data route, and the new data route's integration is HTTP.
- Existing files in the online old Lambda ZIP were preserved byte-for-byte except for the necessary bridge_ws.py patch; new modules were added, and memory is still 128MB.
- The local test Bridge was restarted onto the new implementation; real Chromium / localhost completed the 12 checks above, and screenshots confirmed red ANSI
  and the newline-less `Enter your email (default: demo):` prompt were visible, and Vim modified a real temporary file and saved successfully.
- Real browser keystroke → local PTY echo, 20 times: p50 **430.37ms**, p95 **435.36ms**, max **437.69ms**.
  Includes browser automation / 25ms polling observation error and the local public-network link; not pure Gateway RTT, and not representative of EC2 latency.
- `npm test` and `npm run build` passed; the original 1 skipped test, date deprecation, and bundle size warnings remain.
- Original successful acceptance directory: `terminal-direct-browser-4gnt2yg7` (system private temporary directory), HAR / WS record permissions 0600.
