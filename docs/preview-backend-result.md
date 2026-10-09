# Preview tunnel backend: AWS smoke result

On 2026-10-09, the backend phase was deployed to the `Baton` stack in
`ap-northeast-1` with targeted CloudFormation change sets. The initial
change set `preview-tunnel-6d873bc7687e` added `PreviewDataRoute` and
updated `WsHandler`; CloudFormation also updated two integrations that
reference the Lambda ARN, without replacing them. Change set
`preview-tunnel-fix-76e665930c63` updated only the Lambda code and those
two referenced integrations.

The current WS code key is
`deploy/ws/preview-tunnel-fix-f16ab75982b4.zip`. The pre-preview key was
`deploy/ws/1.0.0-dd4d910-1791453188-1266580.zip`. Before deployment, the
deployed template and WS code matched this worktree's base; the first new ZIP
changed only `bridge_ws.py` and added `preview_tunnel_ws.py`. The second ZIP
changed only `preview_tunnel_ws.py`. The stack finished `UPDATE_COMPLETE`;
the deployed handler files match the committed sources.

`test/bridge/preview-live-smoke.mjs` connected a temporary Bridge as
`test-ec2-preview`, paired a simulated App through the real control and data
APIs, then connected to Vite on `127.0.0.1:5173`:

- `GET /js/ws.js` transferred 546,405 response body bytes, exceeding one
  WebSocket frame. The body matched a direct request byte-for-byte; its
  SHA256 began `d0c9bfa4876b084b`.
- A WebSocket request using Vite's own HMR token received
  `HTTP/1.1 101 Switching Protocols`.
- The smoke client printed `PREVIEW_BACKEND_LIVE_PASS`. After it exited, its
  temporary Bridge connection was gone and all preview session records were
  closed.

The first live attempt exposed a DynamoDB boundary: `port` was read back as
`Decimal` and could not be JSON-encoded in the `ready` message. The server
now converts it to an integer there, and the server test table models that
conversion. A first HMR handshake returned 400 both directly and through the
tunnel because Vite requires its token when an `Origin` header is present;
the smoke client now uses the token from `/@vite/client`.

Verification: 124 server tests, 233 Bridge tests, 12 packaging tests, and
AWS CloudFormation template validation passed. The local Tauri listener and
session-link UI are the next frontend phase. The installed Bridges have not
been updated to advertise `preview=1`; only the temporary smoke Bridge used
the new backend.
