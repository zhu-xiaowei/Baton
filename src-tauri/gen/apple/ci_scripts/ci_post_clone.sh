#!/bin/sh
# Xcode Cloud: install the Node + Rust toolchain that the Tauri "Build Rust Code" phase needs.
set -eu

REPO="${CI_PRIMARY_REPOSITORY_PATH:?}"
cd "${REPO}"

echo "==> Installing Node"
brew install node

echo "==> Installing Rust"
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --target aarch64-apple-ios
. "$HOME/.cargo/env"

echo "==> Installing npm dependencies + building frontend"
npm ci
npm run build

# Xcode build phases do not inherit this shell's PATH, so prepend the toolchains in the CI checkout only.
PBXPROJ="${REPO}/src-tauri/gen/apple/baton.xcodeproj/project.pbxproj"
BREW_BIN="$(brew --prefix)/bin"
sed -i '' "s#shellScript = \"npm run -- tauri ios xcode-script#shellScript = \"export PATH=${HOME}/.cargo/bin:${BREW_BIN}:\$PATH; npm run -- tauri ios xcode-script#" "${PBXPROJ}"
grep -q "export PATH=${HOME}/.cargo/bin" "${PBXPROJ}" || { echo "ERROR: failed to patch build phase PATH" >&2; exit 1; }

node --version; cargo --version
