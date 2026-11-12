# Preview tunnel protocol

A preview tunnel is a `preview` stream channel on the App's one direct socket
(`docs/terminal-direct-integration.md`): frames are `{v:2, kind:'stream', ch:'preview',
id:<tunnelId>, from, m}`, forwarded by API Gateway's HTTP integration without Lambda. The signed
frame limit is 28 KiB; `bytes` messages carry at most 16 KiB of raw data as base64, deflated
(`z:1`) when that pays and the receiving page can inflate.

Tunnel-level messages (no `streamId`):

| Message | Direction | Meaning |
| --- | --- | --- |
| `start {port}` | App → Bridge | Open (or confirm) the tunnel to loopback `port` (1–65535). Repeated every 1.5 s until `started`. |
| `started` | Bridge → App | The tunnel exists; the app can open streams. |
| `stop` | App → Bridge | Close the tunnel and its streams. |
| `gone` | Bridge → App | The Bridge does not know this tunnel (it restarted or dropped it); the app starts a new one. |

The Bridge connects only to `127.0.0.1:port`, then to `[::1]:port` if IPv4 is refused
(`localhost` services on macOS often listen on IPv6 only); a stream cannot choose a different host
or port. A tunnel with no open stream for 10 minutes is closed.

Each browser TCP connection has a UUID `streamId` within one tunnel:

| Message | Direction | Meaning |
| --- | --- | --- |
| `open` | App → Bridge | Dial the tunnel's fixed remote loopback port. |
| `opened` | Bridge → App | The TCP connection is ready; the app can send bytes. |
| `bytes {seq,data}` | Both | Ordered TCP bytes, sequence starting at 1 in each direction. |
| `ack {seq}` | Both | Cumulative confirmation after bytes are written to the receiving TCP socket. |
| `fin {seq}` | Both | Graceful end after all data through `seq` have arrived. |
| `close` | Both | Cancel the stream immediately. |
| `error {code}` | Bridge → App | Connection refused or another I/O failure. |

The receiver must buffer bounded out-of-order chunks and wait for missing
sequences before applying `fin`. The sender pauses its TCP socket when
unacknowledged output reaches 128 KiB. The Bridge limits each direction's
pending bytes to 512 KiB, each tunnel to 24 streams, and each connection to
four tunnels per Bridge. An existing TCP stream is closed when its tunnel closes; the app must open
a new stream after `gone`.

## Delivery over API Gateway

Each signed frame is relayed as an independent `@connections` request, so
frames can arrive out of order and some can be lost. Measured behavior and
the matching rules:

- **Reordering.** An older cumulative `ack` may arrive after a newer one; the
  sender ignores it instead of treating it as a protocol error.
- **Loss on deflate sockets.** Browser WebSockets always negotiate
  `permessage-deflate`, and API Gateway sometimes drops highly compressible
  frames sent on such sockets. The app retransmits unacknowledged `bytes`
  after 1.5 s and repeats `open` until `opened` arrives; the Bridge ignores
  duplicate bytes and answers a duplicate `open` again. Bridge sockets disable
  deflate and have not shown loss.
- **Shared-channel backpressure.** Per-stream windows can exceed the 1 MiB
  channel send limit when many streams burst together. Both sides stop sending
  data frames while more than 256 KiB of channel output is unsent; `ack`, `fin`,
  and `close` are not delayed. The Bridge keeps queued response bytes and `fin`
  until they are sent, even after the local server closes its socket.
- **Connection lifetime.** The direct socket's own keepalive and rebuild cover
  the 10-minute idle and 2-hour limits; the Bridge follows the page's new
  connection ID. When the Bridge answers `gone`, the app keeps its native
  listener and local port, closes in-flight streams, and starts a new tunnel
  with backoff (0, 1, 2, 4, 8 s).

The native loopback listener, browser socket mapping, session links, and in-app
preview navigation use this protocol.

## Known limitation: shared local origin

Every device maps to the same loopback host (`127.0.0.1`, or `localhost` on
macOS). Two simultaneous previews of the same remote port get different local
ports, so origin-scoped storage and Service Workers stay separate, but cookies
are host-scoped and shared. A later preview that reuses a deleted preview's
local port also inherits that origin's Service Worker and site storage. This
matches running several local projects on `localhost`; previews do not isolate
browser state between devices.
