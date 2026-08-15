#!/usr/bin/env bash
# Cross-compile Windows NSIS installer from macOS.
#
# Prerequisites (one-time setup):
#   brew install nsis
#   cargo install --locked cargo-xwin
#   rustup target add x86_64-pc-windows-msvc
#
# Output: src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Baton_<version>_x64-setup.exe

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f "$HOME/.cargo/env" ]]; then
    source "$HOME/.cargo/env"
fi

# Add llvm (for llvm-rc) and lld-link to PATH
export PATH="/opt/homebrew/opt/llvm/bin:$HOME/.local/bin:$PATH"

# Verify prerequisites
if ! brew list makensis &>/dev/null 2>&1 && ! command -v makensis &>/dev/null; then
    echo "ERROR: NSIS not found. Install with: brew install nsis" >&2
    exit 1
fi

if ! command -v lld-link &>/dev/null; then
    echo "ERROR: lld-link not found. Create symlink:" >&2
    echo "  mkdir -p ~/.local/bin && ln -sf ~/.rustup/toolchains/stable-aarch64-apple-darwin/lib/rustlib/aarch64-apple-darwin/bin/rust-lld ~/.local/bin/lld-link" >&2
    exit 1
fi

if ! command -v llvm-rc &>/dev/null; then
    echo "ERROR: llvm-rc not found. Install with: brew install llvm" >&2
    exit 1
fi

if ! rustup target list --installed | grep -q x86_64-pc-windows-msvc; then
    echo "ERROR: Windows target not installed. Run: rustup target add x86_64-pc-windows-msvc" >&2
    exit 1
fi

TARGET="x86_64-pc-windows-msvc"

# Set cross-compilation linker and library paths via env vars (no .cargo/config.toml needed)
XWIN_DIR="$HOME/Library/Caches/cargo-xwin/xwin"
if [[ ! -d "${XWIN_DIR}" ]]; then
    echo "==> Downloading Windows SDK via cargo-xwin (first time only)..."
    cargo xwin env --target "${TARGET}" > /dev/null 2>&1
fi

export CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER="lld-link"
export CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS="-Lnative=${XWIN_DIR}/crt/lib/x86_64 -Lnative=${XWIN_DIR}/sdk/lib/um/x86_64 -Lnative=${XWIN_DIR}/sdk/lib/ucrt/x86_64"

echo "==> Building Windows NSIS installer (cross-compile from macOS)..."
echo "    Target: ${TARGET}"
echo "    Linker: lld-link"

npx tauri build --target "${TARGET}" --bundles nsis

EXE="$(find src-tauri/target/${TARGET}/release/bundle/nsis -name '*.exe' -type f -print -quit 2>/dev/null)"

if [[ -z "${EXE}" ]]; then
    echo "ERROR: no .exe installer produced" >&2
    exit 1
fi

VERSION="$(grep '"version"' src-tauri/tauri.conf.json | head -1 | sed -E 's/.*"([0-9]+\.[0-9]+\.[0-9]+)".*/\1/')"
OUTPUT_DIR="$(dirname "${EXE}")"
FINAL="${OUTPUT_DIR}/Baton_${VERSION}_x64-setup.exe"

if [[ "${EXE}" != "${FINAL}" ]]; then
    mv "${EXE}" "${FINAL}"
fi

echo ""
echo "==> Done: ${FINAL}"
echo "    Size: $(du -h "${FINAL}" | cut -f1)"
echo ""
echo "==> Windows installer ready for distribution: ${FINAL}"
