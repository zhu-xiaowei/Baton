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
