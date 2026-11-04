#!/bin/bash
# usage: setvol.sh <dmg> <icns>
set -euo pipefail
dmg="$1"; icns="$2"; rw="${dmg%.dmg}.rw.dmg"; mnt="$(mktemp -d)"
hdiutil convert -quiet "$dmg" -format UDRW -o "$rw"
hdiutil attach -quiet -nobrowse -noautoopen -mountpoint "$mnt" "$rw"
cp "$icns" "$mnt/.VolumeIcon.icns"
SetFile -a C "$mnt"
hdiutil detach -quiet "$mnt"
rm "$dmg"; hdiutil convert -quiet "$rw" -format UDZO -imagekey zlib-level=9 -o "$dmg"; rm "$rw"
