# v2: the mainland-China relay (hosted service)

Mainland carriers reach Cloudflare through AMS, LAX or LHR (250–320 ms before any work, unstable at peak). A small
Tokyo relay in front of Cloudflare cuts that to one hop over AWS's China peering. Measured 2026-11-21 from Beijing
(China Telecom), WebSocket round trip p50: direct 473–513 ms; Tokyo relay with the account in Tokyo 66–99 ms
(the late-evening peak can reach ~300 ms). Experiment data: `.scratch/docs/v2-china-latency.md` (local).

```
App/Bridge in China ── api-jp.agentbaton.app (DNS-only) ──► Lightsail Tokyo (TCP passthrough, SNI check) ──► Cloudflare NRT ──► account object
everyone else       ── api.agentbaton.app ──────────────────────────────────────────────────────────────► Cloudflare ──────► account object
```

Only REST and `/ws` go through it; R2 transfers, `dl.`, the homepage and the Web App's files do not.

## How it works

- **The relay** (`server/cloudflare/relay/`): nginx `stream` passes TLS through unopened, so certificates stay
  Cloudflare's and nothing is decrypted. It reads only the SNI and drops every other name, so it is no open proxy to
  other Cloudflare sites. No access log.
- **Choosing the entry** (`bridge/entry.mjs`, shared): `/api/version` on `api.` returns `entries` and the caller's
  `country` as Cloudflare sees it (behind a VPN or proxy, the exit's). A caller in `CN` uses the first entry that
  answers; everyone else, and every failure, uses `api.`. The Bridge chooses at start and again when reconnecting fails
  while on the relay; the App at each start (the last choice is used meanwhile), on network changes and when its socket
  keeps failing through the relay. The stored server stays `api.`; the entry is never saved.
- **The Worker** treats the entry hosts as the API host. A WAF custom rule refuses the entry host from any address but
  the relays', so nobody bypasses the relay's limits.
- **Account placement**: a new account's object is created at registration, near its first computer (the pairing
  code's `pair/start` entry), else the App's: the relay or Asia → `apac`, North America → `wnam`/`enam` by longitude,
  Europe → `weur`/`eeur`, and so on. Through the relay it must land in Japan (`NRT`/`KIX`): otherwise register answers
  425 and the App retries with a new key (a new account id), up to twice, then accepts. Objects never move: existing
  accounts keep theirs; re-pair to move (first computer first).
- **Addresses**: Cloudflare sees every relayed caller as the relay. Per-address register/pair/recover limits are 100×
  for relay addresses (`RELAY_IPS`); the per-account limits and the monthly cost cap still apply. Usage statistics
  record such Apps under country/network `relay`. The rate-limiting rule covers `api.` only (on the Free plan it
  cannot exempt an address); the relay limits its callers itself.

## Relay limits (on the instance)

| Limit | Value |
|---|---|
| Connections per address | 100 (nginx `limit_conn`) |
| New connections per address (IPv6: per /64) | 20/s, burst 40 (nftables) |
| Rate per connection | 1 MB/s each way |
| Bytes per address (IPv6: per /64) per day | 1 GiB, then blocked for a day (`relay-guard`, every 5 min) |
| Bytes per month, both directions | 1.8 TB, then relaying stops until the month ends; clients fall back to `api.` |
| Alert | Lightsail alarm mail when NetworkOut stays above the pace of 1.2 TB a month for 2 hours (`ALERT_EMAIL`) |

## Deploy

1. Create the relay in the relay AWS account (Lightsail micro, $7/month, 2 TB both ways):
   `AWS_PROFILE=relay ALERT_EMAIL=<address> server/cloudflare/relay/create.sh baton-relay-1 api-jp.agentbaton.app <admin-ip>/32`
   It prints the static IPv4 and the IPv6 address. Confirm the mail Lightsail sends for a new alert address.
2. Check that the static IP is reachable from mainland China (TCP 443 from several CN probes, e.g. Globalping): some
   AWS ranges are not (a Hong Kong `95.40.x` address was unreachable).
3. Deploy with the entry: `deploy.mjs … --cn-entry api-jp.agentbaton.app --relay-ips <ipv4>,<ipv6> --zero-rtt`.
   This writes the DNS-only records, the route, the WAF custom rule and the Worker variables `API_ENTRIES` / `RELAY_IPS`.
   `--zero-rtt` turns on TLS 0-RTT for the zone (Cloudflare uses it for GET/HEAD/OPTIONS only).
4. Check: `curl https://api.agentbaton.app/api/version` lists `entries`; through the relay `/api/version` answers;
   the entry host from another address answers 403.

To change the relay's configuration, run `setup.sh <hosts>` on it again (SSH from the admin address).

## Scaling and failure

- Lightsail allowances of one bundle in one region are pooled: a second micro, running all month, makes 4 TB. Recreating
  an instance does not reset the month's usage, and one added mid-month adds only part of an allowance.
- Add a relay: `create.sh baton-relay-2 …`, check its IP from China, then deploy with both addresses in `--relay-ips`
  (records, rule and variables follow). Clients need no change. Add it before the first one reaches its cap.
- A relay down or past its cap: clients fail over to `api.` (slower, still working). Accounts placed in Tokyo then reach
  their object from Europe or the US (~500 ms): keep the relay up.
