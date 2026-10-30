# Mobile notifications

Baton notifies when a session goes from running to done, and whenever it needs
input (a tool approval, a question or a plan). Settings has one **Push
notifications** switch; it is on by default.

Both platforms deliver while Baton is in the background, through the local
`tauri-plugin-push` (no Firebase, SNS or community push plugin):

- **iOS** uses APNs, so alerts also arrive after the app is closed. A push
  carries only an event ID and a placeholder ("Baton · Session update"): the
  `NotificationService` extension fetches the real text from the user's own
  server (`GET /api/notifications/event?id=`) before it is shown, using the server
  URL and API key the app shares through the `com.batonai.shared` keychain group
  (no App Group or developer-portal setup; readable while the device is locked).
  Neither the relay nor Apple sees project, session or reply text. If the fetch
  fails in time the placeholder is shown, and a tap still opens the session.
- **Android** runs a foreground service with a minimal ongoing notification,
  "Baton is running in the background". It polls the account's event feed
  natively every 5 seconds in the foreground and 15 seconds in the background
  (WebView timers are throttled there), and posts the alerts itself. Its first
  request only sets a baseline, so nothing is replayed. It stops when the
  switch is turned off, on logout, or when the server rejects the key; opening
  Baton restarts it. Force-stopping Baton ends it; some vendor ROMs also kill
  it when Baton is swiped away unless it is exempted from battery
  optimisation, and Doze can delay polls after the screen has been off for a
  long time.

Alerts read **project · session** (the project's folder name, not its path),
then "Finished" or "Needs input" and a short summary: the last assistant reply
for a finished run, or the command, file, question or plan that needs input. Tapping opens the session, which reloads the current state.

## How it works

Bridge already writes every approval as `needs_input` + `agentDetail` on the
session row, so notifications come only from the `BridgeSessions` DynamoDB
stream. The stream's event filter forwards only session rows entering
`needs_input` or `done#…`; `NotificationWorker` (Python) then keeps:

- `running → completed` (first-time imports are inserts and never alert), and
- entering `needs_input`, or a new `agentDetail` while staying there (the next
  queued approval).

Before alerting, the worker skips what the user already knows:

- **Interrupted turns**: the user stopped it (`[Request interrupted by user…]`).
- **Sessions someone is looking at**: apps subscribed to the session
  (`ROOT#<root>` in the subscriptions table) are asked `notify_check`; one that
  is visible, focused and showing that session answers `notify_seen`, recorded
  on its own subscription row. Any answer within 2 seconds suppresses the alert
  on every device. Leaving a session closes the socket, so there is nothing to
  ask; a suspended iOS socket keeps its row but never answers, so it still gets
  the push. As a fallback, each app also hides an alert for the session it has
  open in the foreground.

A finished turn's summary is its last `end_turn` assistant text. The reply is
persisted separately from the status, so the worker re-reads up to twice, one
second apart, before falling back to the latest text of the turn.

It writes the event to the feed (`NOTIFICATIONS#<account>` in the system table,
24h TTL), which Android polls through `/api/notifications/events`; the row's key
is the ID each of the account's iOS devices is pushed through the shared relay. Devices are stored
as one row per token (`PUSH_DEVICE`, `<environment>:<token>`), so a reinstall
or another account reusing a token replaces the old binding; APNs
`BadDeviceToken`/`Unregistered` deletes it. A failed record is retried by the
stream; `apns-collapse-id` makes a repeated alert replace the earlier one on
the device.

## Push relay

Only the team that publishes the app can push to it, so every Baton stack sends
iOS pushes through one relay in a separate AWS account (`relay/`). The relay is
a single stateless Lambda behind a Function URL with `AWS_IAM` auth: any
SigV4-signed AWS principal may call it (each worker signs with its own role, so
there is nothing to configure) and unsigned requests are refused before the
function runs or is billed. It holds the APNs key, builds the placeholder push
itself and returns APNs' status and reason. It receives only a device token and
an event ID, and stores nothing.

- `POST {token, environment, id}` → `{status, reason}`.
- Requests over 1 KB are refused; each token gets at most 60 alerts a minute per
  warm instance; the account's Lambda concurrency limit caps the total. Above
  it the URL answers 429 instead of queueing, so the worker retries 429 and 5xx
  three times with full jitter (0–2, 0–4, 0–8 s), then the stream retries the record.
- arm64, 512 MB: memory only shortens the cold start (≈6 s at 128 MB, ≈2 s at
  512 MB); warm calls wait on the network and take the same time at any size, so
  drop to 128 MB once the free tier no longer covers it (about 900k alerts a month).
- 7-day error-only logs; an optional email at every 1 USD of actual monthly cost,
  up to 5 USD.
- One kept-alive HTTP/2 connection per APNs origin; the worker also keeps its
  relay connection alive and reuses its AWS clients.

Stacks use the template's `PushRelayUrl` default. Set `PUSH_RELAY_URL` on every
`install.sh` run to use another relay; an empty value disables iOS push (Android
needs no relay).

To deploy the relay (once, in its own account):

1. In Apple Developer, enable **Push Notifications** for `com.batonai.app`.
   Debug builds use the APNs sandbox; release/TestFlight builds production.
2. Create an APNs key (Keys → + → Apple Push Notifications service) and note
   its Key ID and your Team ID. This is not the App Store Connect API key.
3. Store it as a free SSM SecureString in the relay's region:

   ```sh
   aws ssm put-parameter --region <region> --name /baton/apns-key --type SecureString \
     --value "$(jq -n --arg k <KEY_ID> --arg t <TEAM_ID> --rawfile p AuthKey_<KEY_ID>.p8 \
       '{keyId: $k, teamId: $t, privateKey: $p}')"
   ```

4. Run `relay/deploy.sh --region <region> [--alert-email you@example.com]` and
   set the printed URL as the `PushRelayUrl` default in `server/template/Baton.template`.

Never put the key in the app, Git, a Baton stack or a Lambda environment variable.

## Verification

```sh
node --test test/relay/apns-relay.test.mjs
python3 -m pytest test/server/test_notifications.py
```

AWS Device Farm's public iOS devices re-sign apps and remove the Push
Notifications entitlement: they can show the switch, the permission prompt and
a failed registration, but cannot receive APNs. Check delivery on a TestFlight
build: finish a run, trigger two approvals in a row, tap alerts while in the
foreground, in the background and after a cold start, then turn the switch off
and confirm alerts stop.
