#!/bin/bash
# exp.sh build <out> | exp.sh render <cardir> <out>
set -u
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
if [ "$1" = build ]; then
  o="$2"; c="$o/cars"; mkdir -p "$c"; sw_vers | grep ProductVersion
  src="$RUNNER_TEMP/Icon.icon"; rm -rf "$src"; cp -R src-tauri/gen/apple/AppIcon.icon "$src"
  mkdir -p "$RUNNER_TEMP/ac"; actool "$src" --compile "$RUNNER_TEMP/ac" --output-format human-readable-text --errors --output-partial-info-plist "$RUNNER_TEMP/ac/i.plist" --app-icon Icon --include-all-app-icons --enable-on-demand-resources NO --development-region en --target-device mac --minimum-deployment-target 26.0 --platform macosx >/dev/null
  clang -fobjc-arc -framework Foundation -o "$RUNNER_TEMP/cartrim" debug-icons/cartrim.m || exit 1
  T="$RUNNER_TEMP/cartrim"; base="$RUNNER_TEMP/ac/Assets.car"
  DUMP=1 $T "$base" "$RUNNER_TEMP/list.car" list | grep -iE "==|key|asset|write|remove|enumerate|format|comp|bytes="
  for m in rewrite dropicons dropall keep:Icon256x256 keep:Icon128x128; do n=$(echo $m | tr ':' '_'); mkdir -p "$c/$n"; $T "$base" "$c/$n/Assets.car" $m; echo "$n gz=$(gzip -9c "$c/$n/Assets.car" | wc -c)"; done
  mkdir -p "$c/orig"; cp "$base" "$c/orig/Assets.car"
  for n in dropall keep_Icon256x256; do echo "== after $n"; $T "$c/$n/Assets.car" "$RUNNER_TEMP/l2.car" list; done
  shift 2; set -- render "$c" "$o/render"
fi
cars="$2"; o="$3"; d="$RUNNER_TEMP/apps"; mkdir -p "$d" "$o"; sw_vers | grep ProductVersion
mk() { a="$d/$1.app"; mkdir -p "$a/Contents/Resources" "$a/Contents/MacOS"; cp /usr/bin/true "$a/Contents/MacOS/$1"
  /usr/libexec/PlistBuddy -c "Add :CFBundleExecutable string $1" -c "Add :CFBundleIdentifier string com.batonai.exp.$1" -c "Add :CFBundlePackageType string APPL" -c "Add :CFBundleIconFile string icon.icns" "$a/Contents/Info.plist"
  cp debug-icons/volume.icns "$a/Contents/Resources/icon.icns"; }
mk icns_only
for n in $(ls "$cars"); do mk "car_$n"; cp "$cars/$n/Assets.car" "$d/car_$n.app/Contents/Resources/"; /usr/libexec/PlistBuddy -c "Add :CFBundleIconName string Icon" "$d/car_$n.app/Contents/Info.plist"; done
for a in "$d"/*.app; do $LSR -f "$a"; done
swift debug-icons/render.swift "$d" "$o"
