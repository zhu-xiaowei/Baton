#!/bin/sh
# Xcode Cloud: install the Node + Rust toolchain that the Tauri "Build Rust Code" phase needs.
set -eu

REPO="${CI_PRIMARY_REPOSITORY_PATH:?}"
cd "${REPO}"

NODE_VERSION="v24.21.0"

# Xcode Cloud runners may be Intel, where Homebrew has no bottles and builds from source; use the official tarball.
echo "==> Installing Node ${NODE_VERSION}"
case "$(uname -m)" in arm64) NODE_ARCH=arm64 ;; *) NODE_ARCH=x64 ;; esac
NODE_DIR="$HOME/node-${NODE_VERSION}-darwin-${NODE_ARCH}"
curl -sSfL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-darwin-${NODE_ARCH}.tar.gz" | tar -xz -C "$HOME"
export PATH="${NODE_DIR}/bin:$PATH"

echo "==> Installing Rust"
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --target aarch64-apple-ios
. "$HOME/.cargo/env"

echo "==> Installing npm dependencies + building frontend"
npm ci
npm run build

# Xcode build phases do not inherit this shell's PATH, so prepend the toolchains in the CI checkout only.
PBXPROJ="${REPO}/src-tauri/gen/apple/baton.xcodeproj/project.pbxproj"
sed -i '' "s#shellScript = \"npm run -- tauri ios xcode-script#shellScript = \"export PATH=${HOME}/.cargo/bin:${NODE_DIR}/bin:\$PATH; npm run -- tauri ios xcode-script#" "${PBXPROJ}"
grep -q "export PATH=${HOME}/.cargo/bin" "${PBXPROJ}" || { echo "ERROR: failed to patch build phase PATH" >&2; exit 1; }

node --version; cargo --version
