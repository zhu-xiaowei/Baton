#!/bin/bash
# usage: car.sh compile <outdir> | car.sh render <cardir> <outdir>
set -u
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
if [ "$1" = compile ]; then
  o="$2"; mkdir -p "$o"; sw_vers; actool --version | grep -A1 short
  src="$RUNNER_TEMP/Icon.icon"; rm -rf "$src"; cp -R src-tauri/gen/apple/AppIcon.icon "$src"
  base=(--output-format human-readable-text --errors --app-icon Icon --enable-on-demand-resources NO --development-region en --target-device mac --platform macosx)
  v() { n="$1"; shift; mkdir -p "$o/$n"; actool "$src" --compile "$o/$n" --output-partial-info-plist "$o/$n/info.plist" "${base[@]}" "$@" >/dev/null 2>"$o/$n/err.txt"; echo "$n exit=$? car=$(stat -f%z "$o/$n/Assets.car" 2>/dev/null) gz=$(gzip -9c "$o/$n/Assets.car" 2>/dev/null | wc -c) $(cat "$o/$n/err.txt" | head -2)"; }
  v t26_all --minimum-deployment-target 26.0 --include-all-app-icons
  v t26 --minimum-deployment-target 26.0
  v t26_space --minimum-deployment-target 26.0 --optimization space
  v t26_space_png --minimum-deployment-target 26.0 --optimization space --compress-pngs
  v t11 --minimum-deployment-target 11.0
  v t11_space_png --minimum-deployment-target 11.0 --optimization space --compress-pngs
  for n in t26 t11_space_png; do echo "== $n"; assetutil --info "$o/$n/Assets.car" | grep -E '"(AssetType|RenditionName|PixelWidth|SizeOnDisk|Compression)"' | paste - - - - | sort | uniq -c | head -30; done
  exit 0
fi
cars="$2"; o="$3"; d="$RUNNER_TEMP/apps"; mkdir -p "$d" "$o"; sw_vers
mk() { a="$d/$1.app"; mkdir -p "$a/Contents/Resources" "$a/Contents/MacOS"; cp /usr/bin/true "$a/Contents/MacOS/$1"
  /usr/libexec/PlistBuddy -c "Add :CFBundleExecutable string $1" -c "Add :CFBundleIdentifier string com.batonai.debug.$1" -c "Add :CFBundlePackageType string APPL" -c "Add :CFBundleIconFile string icon.icns" "$a/Contents/Info.plist"
  cp debug-icons/A_old.icns "$a/Contents/Resources/icon.icns"; }
mk A_old
for v in B_palette V1_fullbleed_round V2_offwhite V3_gradient V4_inset50 V5_stroke; do mk $v; cp debug-icons/$v.icns "$d/$v.app/Contents/Resources/icon.icns"; done
for n in $(ls "$cars" 2>/dev/null); do [ -f "$cars/$n/Assets.car" ] || continue; mk "car_$n"; cp "$cars/$n/Assets.car" "$d/car_$n.app/Contents/Resources/"; /usr/libexec/PlistBuddy -c "Add :CFBundleIconName string Icon" "$d/car_$n.app/Contents/Info.plist"; done
for a in "$d"/*.app; do $LSR -f "$a"; done
swift debug-icons/render.swift "$d" "$o"
