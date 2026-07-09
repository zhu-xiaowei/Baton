---
description: Build iOS release IPA and upload a new TestFlight build (auto-bumps CFBundleVersion)
allowed-tools: Bash(npm run release:ios), Bash(./scripts/release-ios.sh)
---

Ship a new TestFlight build. Run the release script — it auto-bumps
`CFBundleVersion` in `src-tauri/gen/apple/project.yml`, builds the release IPA,
validates it, and uploads to TestFlight via the App Store Connect API:

```
npm run release:ios
```

Run it in the background (build + upload takes several minutes) and monitor the
output. When it finishes, report the result: the bumped CFBundleVersion, the IPA
path, and whether validation + upload succeeded. If it fails, show the error.

Do not commit the `project.yml` version bump unless asked.
