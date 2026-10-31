# Mobile notifications

Baton alerts when a session goes from running to done, or needs input (an
approval, a question or a plan). Settings has one **Push notifications** switch,
on by default. Alerts show the project folder and the session on their own lines (iOS
title + subtitle; Android sub-text + title), then `✅ Finished · <last reply>` or
`🟡 Needs input · <command, file or question>`; tapping opens the session. Builds
before this layout show `title` (**folder · session**).

The switch is on only when it is wanted and the system allows Baton's notifications. Turning
it on shows the system prompt while the system still asks; declining it leaves the switch off.
Once the system no longer asks (iOS after one denial, Android 13+ after two, or notifications
turned off in system settings), a dialog offers the system's Baton notification settings; the
permission is re-checked whenever the app returns to the foreground.

## Flow

```
Bridge writes status → BridgeSessions stream → NotificationWorker ─┬→ event feed (7d, own account)
                                                                    └→ push-relay → APNs → iPhone
                                                                         (token + event ID only)
```

1. **Trigger.** Bridge writes every approval as `needs_input` + `agentDetail`, so
   the stream filter forwards only rows entering `needs_input` or `done#…`.
   `NotificationWorker` alerts on `running → completed`, on entering
   `needs_input`, and on a new `agentDetail` while waiting.
2. **Skip what the user already knows.** Interrupted turns. Sessions someone is
   looking at on any device: the worker sends `notify_check` to apps subscribed to
   the session (`ROOT#<root>`), and a visible, focused one showing it answers
   `notify_seen` within 2 s. A suspended iOS socket never answers, so it still gets
   the push; each app also hides alerts for the session open in the foreground.
3. **Summary.** The turn's last reply (Claude marks it `end_turn`; Codex appends an
   empty `end_turn` row), or a slash command's `<local-command-stdout>`. The reply is
   persisted separately from the status, so the worker re-reads up to twice, 1 s apart.
4. **Deliver.**
   - **iOS**: the worker posts `{token, environment, id}` to the push relay. The
     push carries only the event ID and a placeholder ("Baton · Session update").
     The `NotificationService` extension fetches the text from the user's own
     server (`GET /api/notifications/event?id=`), using the server URL and key the
     app shares in the `$(AppIdentifierPrefix)com.batonai.shared` keychain group
     (readable while locked). If that fails, the placeholder is shown and a tap
     still opens the session.
   - **Android**: a foreground service ("Baton is running in the background")
     polls `/api/notifications/events` natively, every 5 s in the foreground and
     15 s in the background. Force-stop ends it; some vendor ROMs need Baton
     exempted from battery optimisation.

Devices are one `PUSH_DEVICE` row per `<environment>:<token>`; a permanent APNs
rejection (`BadDeviceToken`, `Unregistered`, `DeviceTokenNotForTopic`,
`TopicDisallowed`) deletes it. A failed iOS push never fails the stream record, so
Android is not alerted twice; if the relay is unreachable the event's remaining iOS
devices are skipped.

## Push relay (`push-relay/`)

Only the team that publishes the app can push to it, so every stack sends iOS
pushes through one stateless relay in its own AWS account. It is one Lambda
behind a Function URL with `AWS_IAM` auth: any SigV4-signed AWS principal may call
it (each worker signs with its own role), and unsigned requests are refused before
it runs. It holds the APNs key, never sees alert text and stores nothing.

- Limits: 1 KB requests, 60 pushes per token per minute per instance, and the
  account's Lambda concurrency. The worker retries 429/5xx with full jitter
  (0–2, 0–4, 0–8 s).
- 512 MB (memory only shortens the ≈2 s cold start); kept-alive HTTP/2 to APNs;
  error-only logs for 7 days; an email at every 1 USD of monthly cost, up to 5 USD.
- Trade-offs: any SigV4-signed AWS account can call it, so someone could use up
  its concurrency and delay every stack's iOS pushes; the cost cap is that
  concurrency limit (set reserved concurrency if the account quota is raised). The
  relay operator sees device tokens and when alerts happen, never their text.
- Stacks use the template's `PushRelayUrl`. `PUSH_RELAY_URL` on `install.sh`
  points at another relay; set it empty to disable iOS push.

Deploy once, in the relay account:

1. Create an APNs key in Apple Developer (Keys → Apple Push Notifications
   service), then store it as a SecureString:

   ```sh
   aws ssm put-parameter --region <region> --name /baton/apns-key --type SecureString \
     --value "$(jq -n --arg k <KEY_ID> --arg t <TEAM_ID> --rawfile p AuthKey_<KEY_ID>.p8 \
       '{keyId: $k, teamId: $t, privateKey: $p}')"
   ```

2. Run `push-relay/deploy.sh --region <region> [--alert-email you@example.com]`
   and set the printed URL as `PushRelayUrl`'s default in `server/template/Baton.template`.

## Verification

```sh
python3 -m pytest test/server/test_notifications.py
node --test test/push-relay/apns-relay.test.mjs
```

AWS Device Farm's public iOS devices strip the push entitlement, so check APNs on
a TestFlight build: finish a run, trigger approvals, tap alerts in the foreground,
the background and after a cold start, and turn the switch off. Deny the permission, turn the
switch on, allow it in Settings and return: the switch turns on.
