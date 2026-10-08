# Release packages

Use Claude Code `/package`, Codex `$package`, or `npm run package` from the repository root. The command collects `release/<package.json version>/Baton.apk`, `Baton.dmg`, and `Baton.exe`. iOS releases use the separate TestFlight workflow.

On macOS the command uses the local Android, macOS, and Windows build scripts. On Linux it dispatches `.github/workflows/package.yml`, which builds on Android/Linux, macOS, and Windows runners, then downloads each successful artifact. The current Linux host has no Rust or Android SDK, and the Windows release script uses macOS tool paths; those local builds cannot run as written on this host.

The existing Xcode Cloud workflow archives the iOS Xcode project for TestFlight. The macOS desktop DMG is a Tauri bundle, so the packaging workflow builds it on a macOS GitHub runner with a Developer ID certificate. The existing App Store Connect API key can also authenticate notarization. Tauri signs and notarizes the DMG; the release script requires a valid app signature and notarization staple before uploading it.

## GitHub Actions setup

The packaging workflow must be present on the GitHub repository's default branch before the first manual dispatch. The command requires a clean checkout on a branch pushed to `zhu-xiaowei/Baton` at the same commit. Set `PACKAGE_GITHUB_REPO=owner/repository` if the connected repository changes. `gh` must be authenticated with permission to run workflows and download artifacts.

Set these GitHub Actions repository secrets:

| Secret | Purpose |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Base64 of the existing `src-tauri/gen/android/baton.keystore` release key. The current Android Gradle config expects alias `baton` and the existing keystore password. |
| `MACOS_CERTIFICATE_P12_BASE64` | Base64 of an exported Developer ID Application certificate **with its private key**. Xcode Cloud's iOS signing does not provide this export. |
| `MACOS_CERTIFICATE_PASSWORD` | Password for that `.p12` export. |
| `APPLE_SIGNING_IDENTITY` | Full Developer ID Application identity installed from the `.p12`. |
| `APPSTORE_KEY_ID` | ID of the App Store Connect key already used by the Linux TestFlight script. |
| `APPSTORE_ISSUER_ID` | Issuer ID for the same key. |
| `APPSTORE_PRIVATE_KEY_BASE64` | Base64 of its matching `AuthKey_*.p8` file. |

To set a base64 secret without creating another local copy, run `base64 < existing-file | tr -d '\n' | gh secret set SECRET_NAME --repo zhu-xiaowei/Baton` on the machine holding the file. Set the text secrets with `gh secret set SECRET_NAME --repo zhu-xiaowei/Baton` so the CLI prompts for the value. The `.p8` permits notarization authentication but cannot sign a desktop app; export the Developer ID certificate and its private key as a `.p12` on the Mac where it was created. Never commit a keystore, `.p8`, `.p12`, or signing password.

Run `node scripts/package-cloud.mjs --dry-run` on Linux to check the source SHA, version, and secret names without starting a build. A real run reports every platform separately. GitHub stores workflow artifacts for seven days; the command copies them into the ignored local `release/` directory. A failed platform makes the command exit nonzero while retaining other downloaded installers.

The Windows NSIS installer is currently unsigned, as it was with the previous local Windows cross compile script. Distributing a signed Windows installer requires a separate Windows code signing certificate.
