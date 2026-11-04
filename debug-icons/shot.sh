#!/bin/bash
set -u
o="$1"; mkdir -p "$o"; sw_vers | grep ProductVersion
gh run download 41788049530 -R "$GITHUB_REPOSITORY" -n Baton-dev-macOS -D "$RUNNER_TEMP/dmg"
hdiutil attach -noautoopen "$RUNNER_TEMP/dmg/Baton.dmg" | tail -1
cp -R /Volumes/Baton/Baton.app /Applications/
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
$LSR -f /Applications/Baton.app
defaults write com.apple.finder ShowExternalHardDrivesOnDesktop -bool true; defaults write com.apple.finder ShowRemovableMediaOnDesktop -bool true
defaults write com.apple.dock tilesize -int 96; killall Finder Dock 2>/dev/null; sleep 6
open -a /Applications/Baton.app; sleep 12
screencapture -x "$o/screen.png" && echo shot-ok
swift debug-icons/render2.swift "$o" volume /Volumes/Baton app /Applications/Baton.app
