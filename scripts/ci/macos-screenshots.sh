#!/bin/bash
# Launch the debug app on a GitHub macOS runner, drive tab and window actions, and record
# screenshots plus traffic-light geometry. Run it by pushing the change under test onto the
# ci/macos-screenshots branch; results are in the macos-screenshots artifact:
#   shots/*.png           window screenshots per step
#   shots/log.txt         window/button geometry per step, drag and resize outcomes
#   shots/buttons-drag.txt traffic-light offsets sampled every 5ms while dragging/resizing
#   shots/app.log         app stdout/stderr
set -u
mkdir -p shots
APP=$(find src-tauri/target/aarch64-apple-darwin/debug/bundle/macos -name '*.app' -maxdepth 1 | head -1)
echo "app: $APP" | tee shots/log.txt
EXE="$APP/Contents/MacOS/$(defaults read "$PWD/$APP/Contents/Info" CFBundleExecutable)"
"$EXE" > shots/app.log 2>&1 &
APP_PID=$!
sleep 12
PROC=$(osascript -e 'tell application "System Events" to get name of first process whose unix id is '"$!" 2>>shots/log.txt)
echo "process: $PROC" | tee -a shots/log.txt
se() { osascript -e "tell application \"System Events\" to tell process \"$PROC\" to $1" 2>>shots/log.txt; }
key() { osascript -e "tell application \"System Events\" to keystroke \"$1\" using {$2}" 2>>shots/log.txt; sleep 2; }
front() { osascript -e "tell application \"System Events\" to set frontmost of process \"$PROC\" to true" 2>>shots/log.txt; sleep 1; }
shot() {
  local pos size
  pos=$(se 'get position of window 1'); size=$(se 'get size of window 1')
  echo "$1 window pos=$pos size=$size buttons=$(se 'get {position, size} of buttons 1 thru 3 of window 1')" | tee -a shots/log.txt
  local x y w h
  IFS=', ' read -r x y <<<"$pos"; IFS=', ' read -r w h <<<"$size"
  screencapture -x -R"$x,$y,$w,$((h < 240 ? h : 240))" "shots/$1.png" 2>>shots/log.txt || screencapture -x "shots/$1-full.png"
}
front
se 'set position of window 1 to {40, 60}'
se 'set size of window 1 to {1100, 700}'
sleep 1
shot 01-launch
key t 'command down'
key t 'command down'
shot 02-three-tabs
osascript -e 'tell application "System Events" to repeat 30 times' -e 'key code 48 using control down' -e 'end repeat' 2>>shots/log.txt
sleep 2
osascript -e 'tell application "System Events" to repeat 30 times' -e 'keystroke "]" using {command down, shift down}' -e 'end repeat' 2>>shots/log.txt
sleep 2
key 1 'command down'
shot 03-cmd1
se 'set size of window 1 to {1500, 700}'
sleep 2
shot 04-wider
if command -v cliclick >/dev/null || brew install cliclick >/dev/null 2>&1; then
  # Tab 1 centre: strip starts 84pt right of the window, tabs are 240pt wide, centre 22pt down.
  cliclick "dd:$((40 + 84 + 120)),$((60 + 22))" "dm:$((40 + 84 + 300)),$((60 + 22))" \
    "dm:$((40 + 84 + 560)),$((60 + 22))" "du:$((40 + 84 + 560)),$((60 + 22))" 2>>shots/log.txt
  sleep 2
  shot 05-after-drag
fi
osascript -e 'tell application "System Events" to key code 13 using {command down}' 2>>shots/log.txt
sleep 2
shot 06-after-cmd-w
key t 'command down'
echo "windows before: $(osascript -e 'tell application "System Events" to count windows of process "'"$PROC"'"')" >> shots/log.txt
osascript -e 'tell application "System Events"' -e 'keystroke "w" using command down' -e 'keystroke "w" using command down' -e 'end tell' 2>>shots/log.txt
sleep 2
echo "windows after: $(osascript -e 'tell application "System Events" to count windows of process "'"$PROC"'"')" >> shots/log.txt
for i in 1 2 3 4; do key n 'command down'; done
osascript -e 'tell application "System Events" to tell process "'"$PROC"'" to set size of every window to {900, 600}' 2>>shots/log.txt; sleep 2
screencapture -x shots/08-cmd-n-windows.png
osascript -e 'tell application "Finder" to activate' 2>>shots/log.txt; sleep 2
front
shot 07-refocus
# Sample traffic-light offsets while dragging the window by the empty strip area, then resizing it.
front
se 'set position of window 1 to {40, 60}'; se 'set size of window 1 to {900, 600}'; sleep 1
WPOS=$(se 'get position of window 1'); IFS=', ' read -r WX WY <<<"$WPOS"
swiftc -O scripts/ci/sample-buttons.swift -o /tmp/sample-buttons 2>>shots/log.txt
/tmp/sample-buttons "$APP_PID" 10 > shots/buttons-drag.txt 2>&1 &
SAMPLER=$!
sleep 0.5
echo "before drag $(se 'get position of window 1')" >> shots/log.txt
cliclick -w 40 "dd:$((WX + 700)),$((WY + 19))" "dm:$((WX + 720)),$((WY + 30))" "dm:$((WX + 740)),$((WY + 45))" \
  "dm:$((WX + 760)),$((WY + 60))" "dm:$((WX + 780)),$((WY + 70))" "du:$((WX + 780)),$((WY + 70))" 2>>shots/log.txt
sleep 1
WPOS=$(se 'get position of window 1'); IFS=', ' read -r WX WY <<<"$WPOS"
echo "after drag $WPOS" >> shots/log.txt
echo "=== live resize" >> shots/buttons-drag.txt
# Live resize from the bottom-right corner.
cliclick -w 40 "dd:$((WX + 899)),$((WY + 599))" "dm:$((WX + 950)),$((WY + 640))" "dm:$((WX + 1000)),$((WY + 680))" \
  "dm:$((WX + 1050)),$((WY + 700))" "du:$((WX + 1050)),$((WY + 700))" 2>>shots/log.txt
echo "after resize $(se 'get size of window 1')" >> shots/log.txt
echo "=== scripted resize" >> shots/buttons-drag.txt
se 'set size of window 1 to {1000, 650}'; sleep 0.3; se 'set size of window 1 to {950, 620}'; sleep 0.3
se 'set position of window 1 to {60, 80}'; sleep 0.3
wait "$SAMPLER"
screencapture -x shots/99-full.png
kill %1 2>/dev/null
exit 0
