# Mobile loopback preview feasibility

On 2026-10-09, AWS Device Farm ran the Android probe on a Google Pixel 8a
(Android 14) in `us-west-2`.

- Run: `arn:aws:devicefarm:us-west-2:949580910056:run:235b7700-e8db-43f3-b086-8a834566ba9f/111e306a-fdce-47d7-badd-caa246041ae7`
- Result: `COMPLETED / PASSED`; setup, built-in fuzz, and teardown each passed.
- App evidence: the device log records `BATON_LOCAL_PREVIEW_PROBE_PASS` from
  both `Tauri/Console` and Rust `app_lib` at 15:04:34.480 UTC.
- Screen evidence: the in-app frame displays “HTML, CSS, JavaScript and fetch
  loaded,” and its parent view displays “Passed.” The screenshot is retained at
  `release/preview-feasibility/DeviceFarm-Pixel8a-PASS.png`.
- Billing reported by Device Farm: 0.33 metered device minutes.

This verifies that the Android Tauri app can start a loopback HTTP listener and
load its page, CSS, JavaScript, and same-origin fetch inside the app. The EC2
data tunnel and Vite hot-reload path require the next backend phase. iOS was not
tested by this Android run.

The APK and downloaded raw Device Farm artifacts are retained locally under
`release/preview-feasibility/` and `.test-runs/preview-devicefarm/`; neither
directory is committed.
