#!/usr/bin/env bash
# Build macOS DMG with code signing + notarization.
#
# Prerequisites:
#   - "Developer ID Application" certificate in Keychain
#   - App-Specific Password generated at https://account.apple.com
#   - Env vars in .env.local: APPLE_SIGNING_IDENTITY, APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID
#
# Output: src-tauri/target/release/bundle/dmg/AgentPeek_<version>_aarch64.dmg

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

npx tauri build --target universal-apple-darwin

DMG="$(find src-tauri/target/universal-apple-darwin/release/bundle/dmg -name '*.dmg' -type f -print -quit 2>/dev/null)"
if [[ -z "${DMG}" ]]; then
    DMG="$(find src-tauri/target/release/bundle/dmg -name '*.dmg' -type f -print -quit 2>/dev/null)"
fi

if [[ -z "${DMG}" ]]; then
    echo "ERROR: no .dmg produced" >&2
    exit 1
fi

# Rename to AgentPeek_<version>.dmg
VERSION="$(grep '"version"' src-tauri/tauri.conf.json | head -1 | sed -E 's/.*"([0-9]+\.[0-9]+\.[0-9]+)".*/\1/')"
OUTPUT_DIR="$(dirname "${DMG}")"
FINAL="${OUTPUT_DIR}/AgentPeek_${VERSION}.dmg"
mv "${DMG}" "${FINAL}"

echo "==> Done: ${FINAL}"
echo "    Size: $(du -h "${FINAL}" | cut -f1)"

# Verify code signature
echo "==> Verifying signature..."
codesign --verify --deep --strict --verbose=2 \
    "$(find src-tauri/target/universal-apple-darwin -path '*/bundle/macos/AgentPeek.app' -type d -print -quit 2>/dev/null)" 2>&1 | tail -3 || true

# Unmount if auto-mounted
hdiutil detach "/Volumes/AgentPeek" 2>/dev/null || true

echo ""
echo "==> DMG ready for distribution: ${FINAL}"
