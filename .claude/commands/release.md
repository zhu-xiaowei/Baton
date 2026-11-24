---
description: Publish Baton <version> as the Latest GitHub Release (version bump PR, packages, release notes, dl.agentbaton.app)
argument-hint: <version>, e.g. 2.0.1
---

Publish Baton `$ARGUMENTS` as a normal (not Pre-release) GitHub Release marked
Latest. The request authorizes the version-bump branch and PR, merging it after
required checks pass, packaging, creating the tag and release, and updating
dl.agentbaton.app. Continue without further approval prompts; stop and report
on any failure instead of skipping or retrying a step. iOS (`/testflight`) and
HarmonyOS are not part of this flow.

Releases ship from `main`. Work in an isolated checkout of the latest
`origin/main`; never force-push.

1. **Prepare.** The version must be higher than the latest normal release
   (`gh release list`); an existing tag for it is only allowed as a Pre-release
   (step 5), and version locations already at it stay unchanged. On branch
   `release/<version>`, update every location in the version table of
   `docs/package.md` (HarmonyOS `versionCode` = major·1000000 + minor·1000 +
   patch; never change iOS `CFBundleVersion`). Update version-specific links
   or QR codes in the three READMEs if any. Write `docs/releases/<version>.md`
   in the format of the previous normal release's notes (`gh release view`
   that tag — e.g. v1.1.0): `## Highlights`, `## Fixes`, `## Upgrade`, English,
   user-facing changes only, from the PRs merged since the previous tag. Links
   into the repository point at the new tag (`blob/v<version>/…`). Upgrade
   covers updating the apps (dl.agentbaton.app, TestFlight), re-running the
   self-hosted server command from the README with the same region, stack and
   profile, and that Bridges update automatically.
2. **Merge.** Open a PR to `main` titled `chore(release): <version>`, wait
   for all required checks, fix failures within the release scope, then
   squash-merge. Record the merged commit SHA.
3. **Package** that exact commit: wait for its `main` push CI to pass, check
   out `main` at the merged SHA and run `/package`. All four platforms must
   succeed.
4. **Check** `release/<version>/`: `Baton.apk`, `Baton.dmg`, `Baton.exe`,
   `Baton.deb`, `Baton.deb.sha256` (matches the deb) and `install.sh` containing
   `DEFAULT_REF="v<version>"`, all non-empty.
5. **Publish:**
   ```
   gh release create v<version> release/<version>/{Baton.apk,Baton.dmg,Baton.exe,Baton.deb,Baton.deb.sha256,install.sh} \
     --target <merged SHA> --title "Baton v<version>" --notes-file docs/releases/<version>.md --latest
   ```
   If the release already exists (e.g. a Pre-release), upload the assets with
   `gh release upload --clobber`, then
   `gh release edit --prerelease=false --latest --notes-file …`.
6. **Downloads:** `node scripts/publish-downloads.mjs v<version>` with
   `CF_ACCOUNT_ID` and `CF_API_TOKEN` (R2 edit + cache purge). If they are not
   available, ask for them; the release stays published.
7. **Verify** that `curl -fsSL https://github.com/agentbaton/baton/releases/latest/download/install.sh`
   contains `DEFAULT_REF="v<version>"` and that the four files on
   dl.agentbaton.app have the release assets' sizes.

Report the PR and merge commit, the release URL, the asset list with sizes,
the dl.agentbaton.app result and both verifications.
