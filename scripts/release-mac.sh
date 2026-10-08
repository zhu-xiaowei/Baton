#!/usr/bin/env bash
# Build macOS DMG with code signing + notarization.
#
# Prerequisites:
#   - "Developer ID Application" certificate in Keychain
#   - App-Specific Password generated at https://account.apple.com
#   - Env vars in .env.local: APPLE_SIGNING_IDENTITY, APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID
#
# Output: src-tauri/target/release/bundle/dmg/Baton_<version>_aarch64.dmg

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f .env.local ]]; then
    set -a; source .env.local; set +a
fi

: "${APPLE_SIGNING_IDENTITY:?Set APPLE_SIGNING_IDENTITY in .env.local}"
: "${APPLE_ID:?Set APPLE_ID in .env.local}"
: "${APPLE_PASSWORD:?Set APPLE_PASSWORD in .env.local}"
: "${APPLE_TEAM_ID:?Set APPLE_TEAM_ID in .env.local}"

if [[ -f "$HOME/.cargo/env" ]]; then
    source "$HOME/.cargo/env"
fi

echo "==> Building macOS universal DMG with signing + notarization..."
echo "    Identity: ${APPLE_SIGNING_IDENTITY}"
echo "    Team ID:  ${APPLE_TEAM_ID}"

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

echo "==> Done: ${FINAL}"
echo "    Size: $(du -h "${FINAL}" | cut -f1)"

# Reject a bundle without a valid Developer ID signature or a stapled notarization.
echo "==> Verifying signature..."
APP="src-tauri/target/universal-apple-darwin/release/bundle/macos/Baton.app"
[[ -d "${APP}" ]] || { echo "ERROR: signed app not found: ${APP}" >&2; exit 1; }
codesign --verify --deep --strict --verbose=2 "${APP}"
echo "==> Verifying notarization staple..."
xcrun stapler validate -v "${FINAL}"

# Unmount if auto-mounted
hdiutil detach "/Volumes/Baton" 2>/dev/null || true

echo ""
echo "==> DMG ready for distribution: ${FINAL}"
