# Release packages

Use Claude Code `/package`, Codex `$package`, or `npm run package` from the repository root. The command collects `release/<package.json version>/Baton.apk`, `Baton.dmg`, and `Baton.exe`. iOS releases use the separate TestFlight workflow.

On macOS the command uses the local Android, macOS, and Windows build scripts. On Linux it dispatches `.github/workflows/package.yml`, which builds on Android/Linux, macOS, and Windows runners, then downloads each successful artifact. The current Linux host has no Rust or Android SDK, and the Windows release script uses macOS tool paths; those local builds cannot run as written on this host.

The existing Xcode Cloud workflow archives the iOS Xcode project for TestFlight. The macOS desktop DMG is a Tauri bundle, so the packaging workflow builds it on a macOS GitHub runner with a Developer ID certificate. The existing App Store Connect API key authenticates notarization. Tauri signs and notarizes the app, then removes its staging copy when bundling the DMG. The release script separately notarizes and staples the DMG, mounts it, and verifies the app's signature and ticket before uploading.

## Prepare a versioned release

Use a branch such as `release/1.1.0` to prepare the version bump and release
notes. Keep these application versions in sync:

| Location | Field |
| --- | --- |
| `package.json`, `package-lock.json` | Package version; both the top-level and root-package versions in the lockfile. Also supplies the frontend version, installer output directory, and deployed server/Bridge version prefix. |
| `bridge/package.json`, `bridge/package-lock.json` | Bridge package version; both locations in its lockfile. |
| `src-tauri/tauri.conf.json` | Native application version; Tauri derives Android `versionName` and `versionCode` from it. |
| `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` | Version of the `baton` package only; dependency and plugin versions are independent. |
| `src-tauri/gen/apple/project.yml` | `CFBundleShortVersionString` for both the app and `NotificationService`. |
| `src-tauri/gen/apple/baton_iOS/Info.plist`, `src-tauri/gen/apple/NotificationService/Info.plist` | Matching `CFBundleShortVersionString` values. |
| `harmony/AppScope/app.json5` | `versionName` and a monotonically increasing `versionCode` (`1001000` for `1.1.0`). |
| `harmony/entry/oh-package.json5` | Entry module package version. |

Keep the iOS `CFBundleVersion` values identical in both targets and their
plists. The TestFlight scripts increment the build number when publishing;
changing the marketing version does not reset it. Do not edit the Android
Gradle fallback values or `bridge/version.mjs`: Tauri writes the Android
properties during the build, and `server/install.sh` generates the deployed
Bridge version as `<package.json version>-<git hash>`.

Update the download links and feature descriptions in all three root READMEs,
and prepare English GitHub Release notes with changes and upgrade instructions.
Draft notes can be kept locally in `docs/releases/<version>.md`.
Update version-specific download QR codes such as `docs/assets/baton_android.avif`,
and decode the generated image to verify that it points to the new release.
Keep previous release notes, protocol examples, test fixtures, and dependency
versions unchanged.

Before packaging, merge the release preparation into `main` and wait for
production CI to pass for the exact commit being packaged. The versioned
`release/1.1.0` branch has no production-CI exemption. Package the resulting
`main` commit with `npm run package`, then publish the `v1.1.0` GitHub release
with `Baton.apk`, `Baton.dmg`, and `Baton.exe` from `release/1.1.0/`. The README
download links become available once those assets are published. iOS uses the
separate TestFlight workflow; HarmonyOS requires its own DevEco build.

## GitHub Actions setup

The packaging workflow must be present on the GitHub repository's default branch before the first manual dispatch. The command requires a clean checkout on a branch pushed to `zhu-xiaowei/Baton` at the same commit. Set `PACKAGE_GITHUB_REPO=owner/repository` if the connected repository changes. `gh` must be authenticated with permission to run workflows and download artifacts.

Release packages normally require successful production CI on `main` for the
exact source commit. The `release/testflight` branch is exempt so candidates can
be packaged before merging; its builds still use the normal release signing
and notarization checks. Other branches and tags do not receive this exemption.
Dev packages do not require main production CI.

The Android keystore remains ignored by Git. Configure binary keys and passwords as GitHub Actions **Secrets**, and public identifiers as GitHub Actions **Variables**:

| Name | Type | Purpose |
| --- | --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Secret | Base64 of the existing `src-tauri/gen/android/baton.keystore` release key. |
| `ANDROID_KEYSTORE_PASSWORD` | Secret | Password for that keystore. |
| `ANDROID_KEY_PASSWORD` | Secret | Password for the `baton` key inside it. |
| `MACOS_CERTIFICATE_P12_BASE64` | Secret | Base64 of an exported Developer ID Application certificate **with its private key**. Xcode Cloud's iOS signing does not provide this export. |
| `MACOS_CERTIFICATE_PASSWORD` | Secret | Password for that `.p12` export. |
| `APPSTORE_PRIVATE_KEY_BASE64` | Secret | Base64 of the `AuthKey_*.p8` file used by TestFlight. |
| `APPLE_SIGNING_IDENTITY` | Variable | Full Developer ID Application identity installed from the `.p12`. |
| `APPSTORE_KEY_ID` | Variable | ID of the App Store Connect key already used by the Linux TestFlight script. |
| `APPSTORE_ISSUER_ID` | Variable | Issuer ID for the same key. |

To set a base64 secret without creating another local copy, run `base64 < existing-file | tr -d '\n' | gh secret set SECRET_NAME --repo zhu-xiaowei/Baton` on the machine holding the file. Set password Secrets with `gh secret set SECRET_NAME --repo zhu-xiaowei/Baton` and identifiers with `gh variable set VARIABLE_NAME --repo zhu-xiaowei/Baton`. GitHub Actions passes the binary Secrets only to the steps that restore temporary signing files. The `.p8` permits notarization authentication but cannot sign a desktop app; export the Developer ID certificate and its private key as a `.p12` on the Mac where it was created. Never commit a keystore, `.p8`, `.p12`, or signing password.

Run `node scripts/package-cloud.mjs --dry-run` on Linux to check the source SHA, version, and secret names without starting a build. A real run reports every platform separately. GitHub stores workflow artifacts for seven days; the command copies them into the ignored local `release/` directory. A failed platform makes the command exit nonzero while retaining other downloaded installers.

The Windows NSIS installer is currently unsigned, as it was with the previous local Windows cross compile script. Distributing a signed Windows installer requires a separate Windows code signing certificate.

## One platform package without a PR

From any clean branch pushed to GitHub, choose a single release package:

```sh
npm run package:android
npm run package:macos
npm run package:windows
```

For a development test package, use:

```sh
npm run package:dev:android  # disposable-key APK
npm run package:dev:ios      # unsigned IPA
npm run package:dev:macos    # unsigned DMG
npm run package:dev:windows  # unsigned NSIS installer
```

`npm run package` and `$package` still build the original three release
installers. There is no `package:ios`: signed iOS releases use the existing
TestFlight flow. The `dev` packages are installable test builds, not live
development servers. The Android dev APK uses a disposable signing key, so
it may require removing a previously installed Baton app.

The command checks that the branch is pushed, starts the selected GitHub
Actions job, verifies its source SHA, and downloads only its artifact.
Release packages go to `release/<version>/`; dev packages go to the ignored
`release/dev/<first 12 characters of SHA>/`. Use
`node scripts/package-cloud.mjs --dev --platform ios --dry-run` to check a
selection without starting a build. The manual **Package** workflow offers
the same selections and defaults to the three release packages.
