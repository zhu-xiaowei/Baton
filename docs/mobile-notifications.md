# Mobile notifications

Android uses the official `tauri-plugin-notification` while Baton is in the
foreground. It checks the account's notification feed every five seconds.
Backgrounding stops delivery, and resuming establishes a new baseline rather
than replaying background events.

iOS uses Apple's APNs. The small local `tauri-plugin-apns` registers the device
token and preserves notification taps across cold starts. It forwards local
notifications to the official plugin's delegate. No community push plugin,
Firebase or SNS is used.

Both platforms show **project name · session name**, followed by the event and
a short summary. Finished runs use the last available assistant response;
approval requests use the command, file path, plan or question. Tapping opens
the existing session view, which reloads the current approval state.

## APNs configuration

The app identifier is `com.batonai.app`. Enable Push Notifications for this
identifier in the Apple Developer account and regenerate signing profiles.
Debug builds use the development APNs environment; release/TestFlight builds
use production.

Create an APNs signing key in Apple Developer and store the following JSON in
AWS Secrets Manager in the server's region:

```json
{
  "keyId": "APPLE_APNS_KEY_ID",
  "teamId": "APPLE_TEAM_ID",
  "privateKey": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
}
```

Use an **APNs signing key**, not the App Store Connect API key used for releases.
Never put the private key in the app, Git repository or notification payload.

Deploy the server with `APNS_KEY_SECRET_ARN` set to the secret's ARN. The installer
preserves this setting on subsequent deployments. Without it, Android local
notifications still work and iOS Settings reports that push is not configured.

The existing session table's stream detects `running → completed` and entry
into `needs_input`. New approval requests also trigger notifications, including
consecutive requests while the session remains in `needs_input`. First-time
history imports do not send completion alerts. Repeated delivery is deduplicated
per event/device, and related status/request events are coalesced.

The Python worker delegates only the HTTP/2 transport to a small Node Lambda
using built-in crypto/http2 and the runtime's Secrets Manager SDK. It sends
directly to `api.push.apple.com` or `api.sandbox.push.apple.com`. Failed events
are retried and retained in the `NotificationFailures` queue.

## Verification

```sh
node --test test/frontend/notifications.test.mjs test/server/apns-sender.test.mjs
python3 -m pytest test/server/test_notifications.py
```

Real-device checks:

- Allow notifications, finish a run, and check project/session names and summary.
- Issue two distinct approval requests and check that each can notify.
- Tap a notification while foregrounded, backgrounded and after an iOS cold start.
- Resolve a request on another device before tapping; show the current state.
- Disable notifications or log out and verify the old registration stops receiving.
- On Android, background the app; do not show or replay foreground-only alerts.

AWS Device Farm's public iOS devices re-sign applications and remove the Push
Notifications entitlement. They can verify local notifications and navigation,
but cannot prove APNs delivery. That check requires a correctly signed physical
iPhone, or a private Device Farm device with signing preserved.
