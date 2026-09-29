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
commit must already be pushed to the GitHub repo Xcode Cloud is connected to;
the script refuses otherwise:

```
npm run release:ios:cloud
```

Run it in the background (build + upload takes several minutes) and monitor the
output. When it finishes, report the result: the build number, the IPA path
(local flow only), and whether validation + upload succeeded. If it fails, show
the error.

Do not commit the `project.yml` version bump unless asked.
