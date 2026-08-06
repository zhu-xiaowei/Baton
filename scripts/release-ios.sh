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
# CFBundleVersion is based on the last packaged build and verified from the IPA.

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

# project.yml is the only persisted build-number source.
PROJECT_YML="src-tauri/gen/apple/project.yml"
CURRENT_BUILD="$(sed -nE 's/.*CFBundleVersion: "([0-9]+)".*/\1/p' "${PROJECT_YML}")"
if [[ ! "${CURRENT_BUILD}" =~ ^[0-9]+$ ]]; then
    echo "ERROR: CFBundleVersion must be an integer in ${PROJECT_YML}" >&2
    exit 1
fi
NEXT_BUILD=$((10#${CURRENT_BUILD} + 1))
echo "==> Requested CFBundleVersion: ${NEXT_BUILD}"

echo "==> Building iOS release IPA (this can take a few minutes)..."
IOS_CONFIG="{\"bundle\":{\"iOS\":{\"bundleVersion\":\"${NEXT_BUILD}\"}}}"
npx tauri ios build --config "${IOS_CONFIG}" --export-method app-store-connect

# Locate the generated IPA — Tauri stores it under:
# src-tauri/gen/apple/build/arm64/AgentPeek.ipa  (path may vary by version)
IPA="$(find src-tauri/gen/apple/build -name '*.ipa' -type f -print -quit)"
if [[ -z "${IPA}" ]]; then
    echo "ERROR: no .ipa produced under src-tauri/gen/apple/build/" >&2
    exit 1
fi
echo "==> Built: ${IPA}"

# Read the value users will get from NSBundle after installing the app.
IPA_INFO="$(mktemp)"
trap 'rm -f "${IPA_INFO}"' EXIT
unzip -p "${IPA}" 'Payload/*.app/Info.plist' > "${IPA_INFO}"
PACKAGED_BUILD="$(plutil -extract CFBundleVersion raw "${IPA_INFO}")"
if [[ ! "${PACKAGED_BUILD}" =~ ^[0-9]+$ ]] || (( 10#${PACKAGED_BUILD} < NEXT_BUILD )); then
    echo "ERROR: packaged CFBundleVersion is ${PACKAGED_BUILD}, expected ${NEXT_BUILD} or higher" >&2
    exit 1
fi
echo "==> Verified CFBundleVersion: ${PACKAGED_BUILD}"

# Xcode may raise the build number during export. Record the packaged value so
# the next release starts above the build that users actually install.
sed -i '' -E "s/CFBundleVersion: \"${CURRENT_BUILD}\"/CFBundleVersion: \"${PACKAGED_BUILD}\"/" "${PROJECT_YML}"
echo "==> Recorded CFBundleVersion: ${PACKAGED_BUILD}"

echo "==> Validating with App Store Connect..."
xcrun altool --validate-app -f "${IPA}" -t ios \
    --apiKey "${KEY_ID}" --apiIssuer "${ISSUER_ID}"

echo "==> Uploading to TestFlight..."
xcrun altool --upload-app -f "${IPA}" -t ios \
    --apiKey "${KEY_ID}" --apiIssuer "${ISSUER_ID}"

echo "==> Done. TestFlight build will be available in ~5-15 minutes."
echo "    https://appstoreconnect.apple.com/apps -> AgentPeek -> TestFlight"
