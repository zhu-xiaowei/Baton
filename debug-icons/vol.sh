#!/bin/bash
set -u
o="$1"; mkdir -p "$o"; sw_vers
curl -sL -o "$RUNNER_TEMP/Baton.dmg" https://github.com/zhu-xiaowei/Baton/releases/download/v1.1.0/Baton.dmg
ls -l "$RUNNER_TEMP/Baton.dmg"; debug-icons/setvol.sh "$RUNNER_TEMP/Baton.dmg" debug-icons/volume.icns; ls -l "$RUNNER_TEMP/Baton.dmg"
hdiutil attach -nobrowse -noautoopen "$RUNNER_TEMP/Baton.dmg" | tail -1
v=/Volumes/Baton; ls -la "$v"; cmp "$v/.VolumeIcon.icns" "$v/Baton.app/Contents/Resources/icon.icns" && echo "volicon == app icon.icns"; cmp "$v/.VolumeIcon.icns" debug-icons/volume.icns && echo "volicon replaced"; GetFileInfo -a "$v"; test -s "$v/.DS_Store" && echo ds_store_ok
cp -R "$v/Baton.app" "$HOME/Desktop/Baton.app"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$HOME/Desktop/Baton.app"
swift debug-icons/render2.swift "$o" volume "$v" app_in_dmg "$v/Baton.app" app_copied "$HOME/Desktop/Baton.app" dmg_file "$RUNNER_TEMP/Baton.dmg"
