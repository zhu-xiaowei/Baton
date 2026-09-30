---
description: Build iOS release IPA and upload a new TestFlight build (auto-bumps CFBundleVersion)
allowed-tools: Bash(npm run release:ios), Bash(./scripts/release-ios.sh), Bash(npm run release:ios:cloud), Bash(node scripts/release-ios-cloud.mjs)
---

Ship a new TestFlight build.

**On macOS** run the local release script — it auto-bumps `CFBundleVersion` in
`src-tauri/gen/apple/project.yml`, builds the release IPA, validates it, and
uploads to TestFlight via the App Store Connect API:

```
npm run release:ios
```

**On Linux (or any non-macOS host)** trigger Xcode Cloud instead. The current
commit must already be pushed to the GitHub repo Xcode Cloud is connected to.
The script increments `CFBundleVersion` in `project.yml` and `Info.plist`,
commits and pushes the version, then starts Xcode Cloud. Use
`node scripts/release-ios-cloud.mjs --dry-run` to find the expected next
version. Xcode Cloud overwrites the IPA build number during export. The first
successful release of app version 1.0.0 needs build 30, above the uploaded
build 29. Align Xcode Cloud > Settings > Build Number > Next Build Number to
30 before triggering. The cloud scripts reject mismatched build numbers
before archive:

```
npm run release:ios:cloud
```

Run it in the background (build + upload takes several minutes) and monitor the
output. When it finishes, report the result: the build number, the IPA path
(local flow only), and whether validation + upload succeeded. If it fails, show
the error.

For the macOS release script, do not commit the `project.yml` version bump
unless asked. The cloud script commits its version bump as part of the release.
