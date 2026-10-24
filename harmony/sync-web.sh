#!/usr/bin/env bash
# Build the Baton web frontend and copy it into the HarmonyOS rawfile bundle.
# Run from anywhere; paths are resolved relative to this script.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
RAWFILE_DIR="$HERE/entry/src/main/resources/rawfile"

if [ ! -d "$REPO_ROOT/node_modules" ]; then
  echo "==> installing deps (npm install)"
  ( cd "$REPO_ROOT" && npm install )
fi

echo "==> vite build (repo root)"
( cd "$REPO_ROOT" && npm run build )

echo "==> clearing $RAWFILE_DIR"
find "$RAWFILE_DIR" -mindepth 1 ! -name '.gitkeep' -delete

echo "==> copying dist/ -> rawfile/"
cp -R "$REPO_ROOT/dist/." "$RAWFILE_DIR/"

echo "==> done. Entry page: rawfile/landing.html"
