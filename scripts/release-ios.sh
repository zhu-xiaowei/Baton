#!/usr/bin/env bash
# Build iOS release IPA and upload to TestFlight via App Store Connect API.
#
# Prerequisites:
#   - .p8 key at ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8
#   - ExportOptions.plist set to method=app-store-connect
#   - Apple Developer Program active, App record created on App Store Connect
#   - Env vars APPSTORE_KEY_ID and APPSTORE_ISSUER_ID set (e.g. via ~/.zshrc):
#       export APPSTORE_KEY_ID="XXXXXXXXXX"
#       export APPSTORE_ISSUER_ID="00000000-0000-0000-0000-000000000000"
#
# CFBundleVersion is auto-bumped on each run.

set -euo pipefail

cd "$(dirname "$0")/.."

# Load secrets from .env.local (gitignored). Copy .env.local.example to set up.
if [[ -f .env.local ]]; then
    # shellcheck disable=SC1091
    set -a; source .env.local; set +a
fi

: "${APPSTORE_KEY_ID:?Set APPSTORE_KEY_ID in .env.local (App Store Connect API key ID)}"
: "${APPSTORE_ISSUER_ID:?Set APPSTORE_ISSUER_ID in .env.local (App Store Connect issuer ID)}"
KEY_ID="${APPSTORE_KEY_ID}"
ISSUER_ID="${APPSTORE_ISSUER_ID}"

# Tauri ios build needs cargo on PATH.
if [[ -f "$HOME/.cargo/env" ]]; then
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
fi

# Auto-bump CFBundleVersion (Apple requires each upload to be strictly higher).
PROJECT_YML="src-tauri/gen/apple/project.yml"
CURRENT_BUILD="$(grep -E 'CFBundleVersion: "[0-9]+"' "${PROJECT_YML}" | sed -E 's/.*"([0-9]+)".*/\1/')"
if [[ -z "${CURRENT_BUILD}" ]]; then
    echo "ERROR: could not parse CFBundleVersion from ${PROJECT_YML}" >&2
    exit 1
fi
NEXT_BUILD=$((CURRENT_BUILD + 1))
sed -i '' -E "s/CFBundleVersion: \"${CURRENT_BUILD}\"/CFBundleVersion: \"${NEXT_BUILD}\"/" "${PROJECT_YML}"
echo "==> Bumped CFBundleVersion: ${CURRENT_BUILD} -> ${NEXT_BUILD}"

echo "==> Building iOS release IPA (this can take a few minutes)..."
npx tauri ios build --build-number "${NEXT_BUILD}" --export-method app-store-connect

# Locate the generated IPA — Tauri stores it under:
# src-tauri/gen/apple/build/arm64/AgentPeek.ipa  (path may vary by version)
IPA="$(find src-tauri/gen/apple/build -name '*.ipa' -type f -print -quit)"
if [[ -z "${IPA}" ]]; then
    echo "ERROR: no .ipa produced under src-tauri/gen/apple/build/" >&2
    exit 1
fi
echo "==> Built: ${IPA}"

echo "==> Validating with App Store Connect..."
xcrun altool --validate-app -f "${IPA}" -t ios \
    --apiKey "${KEY_ID}" --apiIssuer "${ISSUER_ID}"

echo "==> Uploading to TestFlight..."
xcrun altool --upload-app -f "${IPA}" -t ios \
    --apiKey "${KEY_ID}" --apiIssuer "${ISSUER_ID}"

echo "==> Done. TestFlight build will be available in ~5-15 minutes."
echo "    https://appstoreconnect.apple.com/apps -> AgentPeek -> TestFlight"
