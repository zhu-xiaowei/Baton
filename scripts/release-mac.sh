#!/usr/bin/env bash
# Build macOS DMG with code signing + notarization.
#
# Prerequisites:
#   - "Developer ID Application" certificate in Keychain
#   - App Store Connect API key (APPLE_API_KEY, APPLE_API_ISSUER,
#     APPLE_API_KEY_PATH) or Apple ID credentials (APPLE_ID,
#     APPLE_PASSWORD, APPLE_TEAM_ID)
#   - APPLE_SIGNING_IDENTITY, provided in the environment or .env.local
#
# Output: src-tauri/target/release/bundle/dmg/Baton_<version>_aarch64.dmg

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f .env.local ]]; then
    set -a; source .env.local; set +a
fi

: "${APPLE_SIGNING_IDENTITY:?Set APPLE_SIGNING_IDENTITY in .env.local}"
if [[ -n "${APPLE_API_KEY:-}" || -n "${APPLE_API_ISSUER:-}" || -n "${APPLE_API_KEY_PATH:-}" ]]; then
    : "${APPLE_API_KEY:?Set APPLE_API_KEY}"
    : "${APPLE_API_ISSUER:?Set APPLE_API_ISSUER}"
    : "${APPLE_API_KEY_PATH:?Set APPLE_API_KEY_PATH}"
    [[ -f "${APPLE_API_KEY_PATH}" ]] || { echo "ERROR: Apple API key file not found" >&2; exit 1; }
else
    : "${APPLE_ID:?Set APPLE_ID in .env.local}"
    : "${APPLE_PASSWORD:?Set APPLE_PASSWORD in .env.local}"
    : "${APPLE_TEAM_ID:?Set APPLE_TEAM_ID in .env.local}"
fi

if [[ -f "$HOME/.cargo/env" ]]; then
    source "$HOME/.cargo/env"
fi

echo "==> Building macOS universal DMG with signing + notarization..."
echo "    Identity: ${APPLE_SIGNING_IDENTITY}"

npx tauri build --target universal-apple-darwin --bundles dmg

DMG="$(find src-tauri/target/universal-apple-darwin/release/bundle/dmg -name '*.dmg' -type f -print -quit 2>/dev/null)"
if [[ -z "${DMG}" ]]; then
    echo "ERROR: no .dmg produced" >&2
    exit 1
fi

# Rename to Baton_<version>.dmg
VERSION="$(grep '"version"' src-tauri/tauri.conf.json | head -1 | sed -E 's/.*"([0-9]+\.[0-9]+\.[0-9]+)".*/\1/')"
OUTPUT_DIR="$(dirname "${DMG}")"
FINAL="${OUTPUT_DIR}/Baton_${VERSION}.dmg"
if [[ "${DMG}" != "${FINAL}" ]]; then
    mv "${DMG}" "${FINAL}"
fi

# Tauri notarizes and staples the app, then removes its staging copy while
# bundling the DMG. Submit the DMG separately so it has its own stapled ticket.
echo "==> Notarizing DMG..."
if [[ -n "${APPLE_API_KEY:-}" ]]; then
    NOTARY_ARGS=(--key "${APPLE_API_KEY_PATH}" --key-id "${APPLE_API_KEY}" --issuer "${APPLE_API_ISSUER}")
else
    NOTARY_ARGS=(--apple-id "${APPLE_ID}" --password "${APPLE_PASSWORD}" --team-id "${APPLE_TEAM_ID}")
fi
NOTARY_RESULT="$(xcrun notarytool submit "${FINAL}" "${NOTARY_ARGS[@]}" --wait --output-format json)"
printf '%s' "${NOTARY_RESULT}" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const result = JSON.parse(input);
    if (result.status !== "Accepted") {
      console.error(`ERROR: DMG notarization ${result.status} (${result.id})`);
      process.exitCode = 1;
    } else {
      console.log(`    Accepted (${result.id})`);
    }
  });
'
echo "==> Stapling and verifying DMG..."
xcrun stapler staple "${FINAL}"
xcrun stapler validate -v "${FINAL}"

# Verify the signed and stapled app from the finished DMG: Tauri deletes the
# intermediate bundle/macos/Baton.app when it finishes the disk image.
MOUNTPOINT="$(mktemp -d)"
trap 'hdiutil detach "${MOUNTPOINT}" >/dev/null 2>&1 || true; rmdir "${MOUNTPOINT}" >/dev/null 2>&1 || true' EXIT
hdiutil attach -quiet -readonly -nobrowse -mountpoint "${MOUNTPOINT}" "${FINAL}"
APP="${MOUNTPOINT}/Baton.app"
[[ -d "${APP}" ]] || { echo "ERROR: Baton.app not found in DMG" >&2; exit 1; }
[[ -s "${MOUNTPOINT}/.DS_Store" ]] || { echo "ERROR: DMG Finder layout missing (.DS_Store)" >&2; exit 1; }
echo "==> Verifying app signature and notarization staple..."
codesign --verify --deep --strict --verbose=2 "${APP}"
xcrun stapler validate -v "${APP}"
hdiutil detach "${MOUNTPOINT}"
rmdir "${MOUNTPOINT}"
trap - EXIT

echo ""
echo "==> Done: ${FINAL}"
echo "    Size: $(du -h "${FINAL}" | cut -f1)"
echo "==> DMG ready for distribution: ${FINAL}"
