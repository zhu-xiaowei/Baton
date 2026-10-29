# Mobile notifications

Baton notifies when a session goes from running to done, and whenever it needs
input (a tool approval, a question or a plan). Settings has one **Push
notifications** switch; it is on by default.

- **iOS** uses Apple's APNs directly, so alerts arrive in the background. The
  local `tauri-plugin-apns` requests permission, registers the device token and
  keeps notification taps across cold starts. No Firebase, SNS or community
  push plugin is used.
- **Android** uses the official `tauri-plugin-notification` only while Baton is
  in the foreground: it polls the account's event feed every five seconds.
  Resuming starts a fresh baseline instead of replaying background events.

Alerts read **project · session**, then the event and a short summary: the last
assistant reply for a finished run, or the command, file, question or plan
that needs input. Tapping opens the session, which reloads the current state.

## How it works

Bridge already writes every approval as `needs_input` + `agentDetail` on the
session row, so notifications come only from the `BridgeSessions` DynamoDB
stream. The stream's event filter forwards only session rows entering
`needs_input` or `done#…`; `NotificationWorker` (Python) then keeps:

- `running → completed` (first-time imports are inserts and never alert), and
- entering `needs_input`, or a new `agentDetail` while staying there (the next
  queued approval).

It writes the event to the Android feed (`NOTIFICATIONS#<account>` in the
system table, 24h TTL) and sends it to each of the account's iOS devices
through `ApnsSender`, a small Node Lambda using the built-in HTTP/2 client
(Python Lambdas have none). Devices are stored as one row per token
(`PUSH_DEVICE`, `<environment>:<token>`), so a reinstall or another account
reusing a token replaces the old binding; APNs `BadDeviceToken`/`Unregistered`
deletes it. A failed record is retried by the stream; `apns-collapse-id` makes a
repeated alert replace the earlier one on the device.

## APNs configuration

1. In Apple Developer, enable **Push Notifications** for `com.batonai.app`.
   Debug builds use the APNs sandbox; release/TestFlight builds production.
2. Create an APNs key (Keys → + → Apple Push Notifications service) and note
   its Key ID and your Team ID. This is not the App Store Connect API key.
3. Store it as a free SSM SecureString in the stack's region:

   ```sh
   aws ssm put-parameter --region <region> --name /baton/apns-key --type SecureString \
     --value "$(jq -n --arg k <KEY_ID> --arg t <TEAM_ID> --rawfile p AuthKey_<KEY_ID>.p8 \
       '{keyId: $k, teamId: $t, privateKey: $p}')"
   ```

4. Deploy once with `APNS_KEY_PARAMETER=/baton/apns-key ./install.sh ...`. Later
   deploys (including `--rotate-key`) keep it.

Only `ApnsSender`'s role can read the parameter. Never put the key in the app,
Git or a Lambda environment variable. Without it, Android still works and the
iOS switch reports that push is not configured.

The key belongs to the team that publishes the app, so only a stack holding it
can push to the published iOS app.

## Verification

```sh
node --test test/frontend/notifications.test.mjs test/server/apns-sender.test.mjs
python3 -m pytest test/server/test_notifications.py
```

AWS Device Farm's public iOS devices re-sign apps and remove the Push
Notifications entitlement: they can show the switch, the permission prompt and
a failed registration, but cannot receive APNs. Check delivery on a TestFlight
build: finish a run, trigger two approvals in a row, tap alerts while in the
foreground, in the background and after a cold start, then turn the switch off
and confirm alerts stop.
