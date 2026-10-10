---
description: Build iOS release IPA and upload a new TestFlight build (auto-bumps CFBundleVersion)
allowed-tools: Bash(npm run release:ios), Bash(./scripts/release-ios.sh), Bash(npm run release:ios:cloud), Bash(node scripts/release-ios-cloud.mjs --dry-run)
---

For TestFlight update notes (`whatsNew`), default to exactly
`Bug fixes and improvements.` when there are no major new user-facing features.
Use feature-specific notes for major additions, or the user's supplied wording.

A request to publish authorizes the release's source commits, branch creation,
pushes, build-number bump, cloud run, and TestFlight group assignment. Continue
without routine approval prompts. Before publishing, inspect `git status
--short`, including untracked files. Automatically commit changes within the
requested release scope and preserve unrelated work, using an isolated checkout
when needed. Continue with the release in the same invocation.

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

**On Linux:** Run the release from an unprotected release branch, not `main`.
Reuse the current unprotected release branch, or automatically create a branch
such as `release/testflight-<build-number>`.
After the release changes are committed, push the source commit to the GitHub
repository connected to Xcode Cloud. Run
`node scripts/release-ios-cloud.mjs --dry-run` as a preflight, then continue
with the real release on that same branch:

```
npm run release:ios:cloud
```

The cloud script commits and pushes its own build-number bump before starting
Xcode Cloud, so running it on protected `main` fails before packaging or upload.
A PR is not required to publish. Create or reuse a PR targeting `main` only when
the user asks for one; do not wait for a PR or merge before releasing. Do not
bypass branch protection. Creating a PR is not proof of upload.

If a protected-branch push already failed after the bump commit was created,
preserve that commit. Automatically create an unprotected release branch from
it and push the branch. Rerun the dry-run and release
there; the script decides whether to reuse the prepared version. Do not manually
bump again just because the push failed.

The script waits for a valid upload and adds it to the internal **Test** group.
The dry-run is not completion of `/testflight`. Report the cloud run ID,
build number, and TestFlight state; include a PR URL only if one exists.
If upload succeeded but group assignment
failed, do not start another release for that error.
