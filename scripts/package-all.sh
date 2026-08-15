#!/usr/bin/env bash
# Build Android APK, macOS DMG, and Windows EXE, then copy each into
# release/<version>/ (version read from package.json) as Baton.{apk,dmg,exe}.
# Each platform builds independently — one failing never blocks the others.
# Invoked by the /package slash command. iOS is excluded (TestFlight flow).

set -uo pipefail
cd "$(dirname "$0")/.."

VERSION="$(node -p "require('./package.json').version")"
DEST="release/${VERSION}"
mkdir -p "${DEST}"
echo "==> Packaging Baton v${VERSION} -> ${DEST}/"

RESULTS=()

# Newest matching file (BSD/macOS-compatible; paths here have no spaces).
newest() { ls -t $(find "$@" 2>/dev/null) 2>/dev/null | head -1; }

package_one() { # label  build-cmd  out-name  find-args...
  local label="$1" cmd="$2" out="$3"; shift 3
  echo ""
  echo "================ ${label} ================"
  if ! eval "${cmd}"; then RESULTS+=("${label}: BUILD FAILED"); return; fi
  local artifact; artifact="$(newest "$@")"
  if [[ -z "${artifact}" || ! -f "${artifact}" ]]; then
    RESULTS+=("${label}: artifact not found"); return
  fi
  cp -f "${artifact}" "${DEST}/${out}"
  RESULTS+=("${label}: ${DEST}/${out} ($(du -h "${DEST}/${out}" | cut -f1))")
}

package_one "Android" "npm run build:android" "Baton.apk" \
  src-tauri/gen/android -name "*.apk" -path "*release*" -type f
package_one "macOS"   "npm run build:mac"     "Baton.dmg" \
  src-tauri/target -path "*bundle/dmg/*.dmg" -type f
package_one "Windows" "npm run build:windows" "Baton.exe" \
  src-tauri/target/x86_64-pc-windows-msvc -path "*bundle/nsis/*.exe" -type f

echo ""
echo "==================== SUMMARY (v${VERSION}) ===================="
for r in "${RESULTS[@]}"; do echo "  - ${r}"; done
