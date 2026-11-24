---
description: Publish Baton <version> as the Latest GitHub Release (version bump PR, packages, release notes, dl.agentbaton.app)
argument-hint: <version> [--auto], e.g. 2.0.1
---

Arguments: `$ARGUMENTS` (version, optional `--auto`). Publish that version from
`main` as a normal (not Pre-release) GitHub Release marked Latest. The request
authorizes steps 1–3 up to a green PR. There, stop and ask: summarize the
version changes, the full release notes and the CI result. Once the user
confirms, or immediately with `--auto`, run steps 3–8 without further prompts.
On a failure, stop and report it. Every step first checks whether it is already done and
then reuses its result, so re-running the same command resumes the release.
Work in an isolated checkout of the latest `origin/main`; never force-push.
iOS (`/testflight`) and HarmonyOS builds are not part of this flow.

1. **Prepare** branch `release/<version>` (reuse it and its PR if present). The
   version must be higher than the latest normal release (`gh release list`);
   an existing tag is only allowed as a Pre-release of it. Follow "Prepare a
   versioned release" in `docs/package.md`: every location in its version table
   (HarmonyOS `versionCode` = major·1000000 + minor·1000 + patch; leave iOS
   `CFBundleVersion`), README download links and feature descriptions in all
   three languages, and version-specific QR codes (decode them to verify).
2. **Notes:** write `docs/releases/<version>.md` locally (untracked) in the
   format of the previous normal release (`gh release view <tag>`, e.g. v1.1.0):
   `## Highlights`, `## Fixes`, `## Upgrade`; English, user-facing changes from
   the PRs merged since the previous tag; repository links at `blob/v<version>/`.
   Upgrade: update the apps (dl.agentbaton.app, TestFlight), re-run the README's
   self-hosted server command with the same region, stack and profile; Bridges
   update automatically.
3. **Merge:** PR `chore(release): <version>` to `main`, wait for all required
   checks and fix failures within the release scope. After the confirmation
   above, squash-merge and use the merged commit from here on.
4. **Package:** after that commit's `main` push CI passes, check out `main` at it
   and run `/package` (skip if `release/<version>/` already holds a complete
   set built from it). All four platforms must succeed.
5. **Check** `release/<version>/`: non-empty `Baton.apk`, `Baton.dmg`,
   `Baton.exe`, `Baton.deb`, `Baton.deb.sha256` matching the deb, and
   `install.sh` containing `DEFAULT_REF="v<version>"`.
6. **Publish atomically:** upload everything to a draft first, so Latest never
   points at an incomplete release:
   ```
   gh release create v<version> release/<version>/{Baton.apk,Baton.dmg,Baton.exe,Baton.deb,Baton.deb.sha256,install.sh} \
     --draft --target <merged commit> --title "Baton v<version>" --notes-file docs/releases/<version>.md
   gh release edit v<version> --draft=false --prerelease=false --latest
   ```
   For an existing draft or Pre-release, `gh release upload --clobber` the
   assets and update the notes before the same `edit`.
7. **Downloads:** `node scripts/publish-downloads.mjs v<version>` (env
   `CF_ACCOUNT_ID`, `CF_API_TOKEN`; ask for them if missing).
8. **Verify:** `curl -fsSL https://github.com/agentbaton/baton/releases/latest/download/install.sh`
   contains `DEFAULT_REF="v<version>"`, and the four dl.agentbaton.app files
   have the release assets' sizes.

Report the PR, merged commit, release URL, assets with sizes, and the results
of steps 7 and 8.
