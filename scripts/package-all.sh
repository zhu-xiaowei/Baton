#!/usr/bin/env bash
# Build Android APK, macOS DMG, and Windows EXE, then copy each into
# release/<version>/ (version read from package.json) as Baton.{apk,dmg,exe}.
# Each platform builds independently — one failing never blocks the others.
# Invoked by /package and $package. iOS is excluded (TestFlight flow).

set -uo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
  exec node scripts/package-cloud.mjs "$@"
fi

if (( $# > 0 )); then
  echo "Usage: bash scripts/package-all.sh" >&2
  exit 2
fi

if [[ -f .env.local ]]; then
  set -a; source .env.local; set +a
fi

# Populate env that interactive shells (.zshrc) provide but /package, CI, cron do not.
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"                    # Android needs cargo on PATH
export LANG="${LANG:-en_US.UTF-8}" LC_ALL="${LC_ALL:-en_US.UTF-8}"   # makensis std::bad_alloc under C locale
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
if [ -z "${NDK_HOME:-}" ] && [ -d "${ANDROID_HOME}/ndk" ]; then       # newest installed NDK
  export NDK_HOME="${ANDROID_HOME}/ndk/$(ls "${ANDROID_HOME}/ndk" | sort -V | tail -1)"
fi

VERSION="$(node -p "require('./package.json').version")"
DEST="release/${VERSION}"
mkdir -p "${DEST}"
echo "==> Packaging Baton v${VERSION} -> ${DEST}/"

RESULTS=()

# Newest matching file (BSD/macOS-compatible; paths here have no spaces).
newest() { find "$@" 2>/dev/null | while IFS= read -r file; do stat -f '%m %N' "$file"; done | sort -nr | head -1 | cut -d' ' -f2-; }

package_one() { # label  build-cmd  out-name  find-args...
  local label="$1" cmd="$2" out="$3"; shift 3
  echo ""
  echo "================ ${label} ================"
  rm -f "${DEST}/${out}"
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
if ((${#RESULTS[@]} != 3)) || printf '%s\n' "${RESULTS[@]}" | grep -Eq 'BUILD FAILED|artifact not found'; then
  exit 1
fi
