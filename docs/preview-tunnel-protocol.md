# Preview tunnel protocol (v1)

The app requests `preview_tunnel {v:1,op:"open",tunnelId,device,port}` on its
authenticated control WebSocket. `port` is an integer from 1 to 65535.
The server selects the active Bridge for that account and device. The Bridge
connects only to `127.0.0.1:port`; the data stream cannot choose a different
host or port.

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

The native loopback listener, browser socket mapping, session links, and in-app
preview navigation use this protocol.
