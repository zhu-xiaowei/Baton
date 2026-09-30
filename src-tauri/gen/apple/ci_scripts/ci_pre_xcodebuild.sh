#!/bin/sh
# Xcode Cloud always assigns its own build number; fail before archive if it
# differs from the version prepared in the repository.
set -eu

PROJECT_YML="${CI_PRIMARY_REPOSITORY_PATH:?}/src-tauri/gen/apple/project.yml"
EXPECTED="$(sed -nE 's/^[[:space:]]*CFBundleVersion: "([0-9]+)"[[:space:]]*$/\1/p' "${PROJECT_YML}")"
if [ -z "${EXPECTED}" ] || [ "${CI_BUILD_NUMBER:-}" != "${EXPECTED}" ]; then
    echo "ERROR: Xcode Cloud build number ${CI_BUILD_NUMBER:-unset} differs from configured CFBundleVersion ${EXPECTED:-unset}." >&2
    echo "Set Xcode Cloud > Settings > Build Number > Next Build Number to ${EXPECTED:-the configured version} in App Store Connect, then retry." >&2
    exit 1
fi
echo "==> Xcode Cloud build number ${CI_BUILD_NUMBER} matches configured CFBundleVersion"
