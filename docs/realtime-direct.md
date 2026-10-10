# Real-time Messages via Header-Signed Direct Forwarding

2026-09-20: Code implementation complete; this document does not imply it has been deployed or that new end-to-end chat latency has been measured.

## Scope of the Change

Only the Bridge → App real-time transport is replaced. Existing event structure, turnId/seq, the frontend TurnEventQueue, history barrier, rendering, and JSONL persistence are kept.
No new long-running service, DynamoDB table, or WebSocket API is created; the terminal's existing independent data API and signing role are reused.

Direct forwarding scope:

- The six `stream_*` turn events.
- `permission_request` and `permission_resolved` with a valid turnId/seq.
- Real-time complete `messages` with a valid turnId/seq and `noCache: true`.

Ordinary `messages` that require storage and `messages_ack`, JSONL sync, user commands, file/Git RPC, and session status notifications still use the original path.
The watcher, HTTP history upload, DDB writes, and frontend ordering algorithm are unchanged.

## Data and Control

```text
Real-time: Bridge original control WS → realtime_direct_data HTTP integration
                     → independent data API POST @connections → App data WS

Control: original control WS → WsHandler Lambda
      open/join, STS hello, resolve, subscription invalidation notices

History: original JSONL/watcher → original WS storage path or HTTP upload → original Lambda/DDB
```

Bridge does not add a second WS; each new-version App control connection adds one receive-only data WS. Multiple tabs each bind their own data connection.
The main API adds a `realtime_direct_data` HTTP route, but its target is the independent data API; STS permissions are not extended to the original control API.

1. Bridge declares `realtime=1` on the original control connection, obtains 900-second short-lived credentials via `hello`, and requests a refresh 60 seconds before expiry.
2. The App requests `open` over the trusted control connection and receives a bindingId, a one-time join token, and the data endpoint.
3. The data connection's `$connect` uses the `realtime_data` role; `join` verifies same account, real endpoint, binding, the 45-second deadline, and the token hash.
4. Lambda consumes the token via a conditional update; the HMAC key is sent to the App only over the trusted control WS. The App never receives STS credentials.
5. The first time Bridge sends for a given session/initiator combination, it requests `resolve`. The server reuses the existing subscription query and replyConnectionId ownership check,
   returning same-account receivers and their data bindings; not-ready or old clients return only the control connection ID.
6. The route cache holds at most 128 entries for 30 seconds. Subscribe, unsubscribe, data binding changes, and disconnects notify Bridge of invalidation through the control plane.
7. Bridge queues and signs in original event order and delivers via the HTTP integration. The receiver verifies the MAC, bindingId, and event type, then hands off to the original `handleWsMessage()`.

Initial route discovery, authorization, and binding require control-plane round trips, so this change does not promise a faster first frame on cold start.
In steady state, when all receivers support direct forwarding, normally sized real-time events of the types above do not trigger the forwarding Lambda.

## Fallback and Recovery

- Old server does not respond to the new protocol, or returns unsupported: the original Bridge/App control WS keeps working.
- Old Bridge: still delivers to all Apps through the original Lambda; the new App's extra data connection does not affect the original message entry.
- Mixed old and new Apps: new-version targets get direct forwarding, old-version targets continue through Lambda.
- Unauthorized, route resolution timeout, expired credentials, too much local queueing, or a signed frame over 28 KiB: fall back to the original send path.
- Mixed fallback carries an internal `directDeliveredTo`; Lambda skips targets already queued for direct forwarding and removes this field before delivery, keeping the payload consistent for seq dedup.
- Rebuilding the control connection clears old authorization, routes, and pending resolve requests; the old connection's queue is not automatically replayed onto the new connection.
- A data connection disconnect cleans up the binding and rebuilds it; the new bindingId/key rejects delayed frames from the old binding. On disconnect, becoming ready again, or falling back to the control path, the frontend reuses the history snapshot to recover, filling in lost answers and end states; recovery keeps pending questions not yet confirmed by a history echo.
- When the control or data WS reconnects, a loading ring is shown only to the left of the Git button in the header; it hides once the connection recovers or the data channel falls back. The answer spinner is controlled only by running state, and the send/stop buttons carry no connection indication.

A successful send is still not confirmation that "the browser consumed it" or "DDB persisted it". This change adds no per-event ACK, unlimited retransmission, or exactly-once mechanism.
The HTTP integration can still fail or reorder; the existing seq/gap/checkpoint/history recovery remains necessary.

## Security Boundary

The data API forbids connections from the app/bridge control roles; `realtime_data` connections cannot execute chat commands or request Bridge credentials.
The client only accepts real-time events that pass session HMAC verification, and does not accept bare control messages on the data channel.
Terminal and chat data in the same API use different message types and independent binding keys, so unverified frames cannot be handed to the chat entry.

As with the existing Terminal Direct, the ManageConnections permission is scoped to the independent data API, not a strict per-connection-ID IAM ACL.
HMAC prevents content injection but does not eliminate bandwidth or resource abuse by holders of that API permission; it cannot be used to claim support for untrusted multi-tenancy.
Keys are not written to logs or to frontend persistent storage.

## Files and Deployment

- `bridge/realtime-direct.mjs`: Bridge route cache, signing queue, direct send, and compatibility fallback.
- `bridge/realtime-direct-protocol.mjs`: event contract and App receive/binding state machine.
- `server/src/realtime_direct_ws.py`: low-frequency control plane; uses the existing ConnectionsTable.
- `server/src/bridge_ws.py`: control-plane integration, subscription invalidation, and mixed-client fallback.
- `server/template/Baton.template`: adds the main API's HTTP integration/route and sets `REALTIME_DIRECT_ENABLED=1`.
- `server/install.sh`: the WS Lambda ZIP includes the new control module.

First update the server template and Lambda ZIP through the original release flow, wait for the route deployment to finish, then update Bridge and the frontend.
Updating only the Python files is not enough; updating only the frontend/Bridge cannot enable the new HTTP route either.
Do not use the old `deploy-terminal-direct.py` in place of this full template update; it only handles the historical terminal incremental deployment.
Bridge checks for updates once at startup and after WebSocket reconnect; existing 4-minute heartbeat replies carry `bridgeVersion`, and only a version mismatch triggers another check, with no dedicated update timer. The server API and WS Lambdas must both receive `AppVersion`. After the new package validates it restarts automatically, without deferring the update for existing processes/terminals; running sessions may be interrupted.

To roll back, disable WsHandler's `REALTIME_DIRECT_ENABLED` and reconnect Bridge/pages, or roll back the Bridge/frontend version.
The original message routing and history storage interfaces are kept, so no data migration is needed.

## Verification

```bash
npm test
npm run build
```

New tests cover real signed frames, multiple receivers/mixed old clients, original arrival order, original seq ordering and rendering, credential expiry, large-frame fallback,
resolve timeout, snapshot at send time, subscription invalidation, disconnects, cross-account/expired/replayed join rejection, and isolation of the original control API.
The deployment template is additionally validated with AWS CloudFormation validate-template.

This round was not automatically deployed to production. After rollout, confirm that the Bridge WS high-frequency frame action is `realtime_direct_data`,
that the App receives authenticated real-time frames over the independent data WS, and check WsHandler invocation counts.
Then use the same streaming load to A/B compare old/new path latency and seq queue wait time; the 30-odd ms from historical terminal measurements
must not be taken directly as the local chat end-to-end acceptance result.
