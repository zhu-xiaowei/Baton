---
description: Build iOS release IPA and upload a new TestFlight build (auto-bumps CFBundleVersion)
allowed-tools: Bash(npm run release:ios), Bash(./scripts/release-ios.sh), Bash(npm run release:ios:cloud), Bash(node scripts/release-ios-cloud.mjs --dry-run)
---

Before publishing, inspect `git status --short`, including untracked files.
If there are changes, show the files that would be included and ask whether
to commit them and continue. Wait for the answer. Commit only agreed files;
if the user declines, stop. When the worktree is clean, continue with the
release in the same invocation.

**On macOS:**

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

**On Linux:** After the agreed changes are committed, push the source commit
to the GitHub repository connected to Xcode Cloud. Run
`node scripts/release-ios-cloud.mjs --dry-run` as a preflight, then continue
with the real release:

```
npm run release:ios:cloud
```

The cloud script commits and pushes its own build-number bump, waits for a
valid upload, and adds it to the internal **Test** group. The dry-run is not
completion of `/testflight`. Report the cloud run ID, build number, and
TestFlight state. If upload succeeded but group assignment failed, do not
start another release for that error.
