# Preview tunnel protocol (v1)

The app requests `preview_tunnel {v:1,op:"open",tunnelId,device,port}` on its
authenticated control WebSocket. `port` is an integer from 1 to 65535.
The server selects the active Bridge for that account and device. The Bridge
connects only to `127.0.0.1:port`, then to `[::1]:port` if IPv4 is refused
(`localhost` services on macOS often listen on IPv6 only); the data stream
cannot choose a different host or port.

The server sends both sides an `offer` with their own one-time join token.
Each opens the existing dedicated data API with `role=preview_data`, then sends
`preview_tunnel {v:1,op:"join",tunnelId,side,joinToken}`. Once both data
connections join, control connections receive `ready` with connection IDs,
a shared frame key, and short-lived signing credentials. The app may send
`renew` before those credentials expire. Either control side can send `close`.
Control or data disconnect closes the tunnel.

Signed data frames use the new `preview_data` route on the existing terminal
data API. API Gateway's HTTP integration forwards the signed body to the
other data connection without invoking Lambda per chunk. The body is
HMAC-protected with the tunnel's frame key. The signed frame limit is 28 KiB;
`bytes` messages carry at most 16 KiB of raw data as base64.

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
four tunnels. An existing TCP stream is closed when its tunnel closes or its
data channel disconnects; the app must open a new stream after reconnecting.

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
- **Idle timeout.** API Gateway closes a socket after 10 idle minutes, and
  frames posted to a socket do not count as its activity. Each data connection
  sends `{action:"ping"}` every 5 minutes.
- **Connection lifetime.** API Gateway closes every WebSocket within 2 hours
  (`1001`) and occasionally with `1012`. When the Bridge or a data connection
  drops, the app keeps its native listener and local port, closes in-flight
  streams, and pairs a new tunnel with backoff (0, 1, 2, 4, 8 s). New browser
  connections wait for the new channel; the tunnel fails only after every
  attempt fails.

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
