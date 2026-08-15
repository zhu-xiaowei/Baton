#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
elif [[ $# -gt 0 ]]; then
  echo "Usage: $0 [--dry-run]" >&2
  exit 2
fi

BRIDGE_DIRS=(
  "$HOME/.baton-bridge"
  "$HOME/.agentpeek-bridge"
  "$HOME/.claude-bridge"
)
LAUNCHD_LABELS=(
  "com.baton.bridge"
  "com.agentpeek.bridge"
  "com.claude.bridge"
)
SYSTEMD_UNITS=(
  "baton-bridge.service"
  "agentpeek-bridge.service"
  "claude-bridge.service"
)

run() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  if ! $DRY_RUN; then "$@"; fi
}

run_ignore() {
  printf '+'
  printf ' %q' "$@"
  printf ' (ignore errors)\n'
  if ! $DRY_RUN; then "$@" >/dev/null 2>&1 || true; fi
}

remove_path() {
  local target="$1"
  if [[ -e "$target" || -L "$target" ]]; then
    run rm -rf "$target"
  fi
}

stop_bridge_processes() {
  local pids
  pids="$(
    ps -eo pid=,comm=,args= | awk '
      $0 ~ /(^|[[:space:]])[^[:space:]]*\/?node(js)?([[:space:]]|$)/ &&
      $0 ~ /\/\.(baton|agentpeek|claude)-bridge\/(bridge|bridge-launcher)\.mjs/ {
        print $1
      }
    '
  )"
  [[ -z "$pids" ]] && return

  while read -r pid; do
    [[ -n "$pid" ]] && run_ignore kill -TERM "$pid"
  done <<< "$pids"
  if ! $DRY_RUN; then sleep 1; fi
  while read -r pid; do
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      run_ignore kill -KILL "$pid"
    fi
  done <<< "$pids"
}

uninstall_launchd() {
  local uid label plist
  uid="$(id -u)"

  for label in "${LAUNCHD_LABELS[@]}"; do
    run_ignore launchctl bootout "gui/$uid/$label"
    run_ignore launchctl remove "$label"
  done

  for label in "${LAUNCHD_LABELS[@]}"; do
    plist="$HOME/Library/LaunchAgents/$label.plist"
    if [[ -e "$plist" ]]; then
      run_ignore launchctl bootout "gui/$uid" "$plist"
      remove_path "$plist"
    fi
  done

  for label in "${LAUNCHD_LABELS[@]}"; do
    plist="/Library/LaunchAgents/$label.plist"
    if [[ -e "$plist" ]]; then
      run_ignore launchctl bootout "gui/$uid" "$plist"
      run sudo rm -f "$plist"
    fi

    plist="/Library/LaunchDaemons/$label.plist"
    if [[ -e "$plist" ]]; then
      run_ignore sudo launchctl bootout system "$plist"
      run sudo rm -f "$plist"
    fi
  done
}

uninstall_systemd() {
  local unit dir system_changed=false
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

  for unit in "${SYSTEMD_UNITS[@]}"; do
    run_ignore systemctl --user disable --now "$unit"
    run_ignore systemctl --user reset-failed "$unit"
  done

  for dir in "$HOME/.config/systemd/user" "$HOME/.local/share/systemd/user"; do
    for unit in "${SYSTEMD_UNITS[@]}"; do
      remove_path "$dir/$unit"
    done
  done
  run_ignore systemctl --user daemon-reload

  for unit in "${SYSTEMD_UNITS[@]}"; do
    if systemctl list-unit-files "$unit" --no-legend 2>/dev/null | grep -q "$unit"; then
      run_ignore sudo systemctl disable --now "$unit"
    fi
  done
  for dir in /etc/systemd/system /usr/local/lib/systemd/system /etc/systemd/user /usr/local/lib/systemd/user; do
    for unit in "${SYSTEMD_UNITS[@]}"; do
      if [[ -e "$dir/$unit" ]]; then
        run sudo rm -f "$dir/$unit"
        system_changed=true
      fi
    done
  done
  if $system_changed; then
    run_ignore sudo systemctl daemon-reload
  fi
}

case "$(uname -s)" in
  Darwin) uninstall_launchd ;;
  Linux) uninstall_systemd ;;
  *)
    echo "Unsupported operating system: $(uname -s)" >&2
    exit 1
    ;;
esac

stop_bridge_processes
for dir in "${BRIDGE_DIRS[@]}"; do
  remove_path "$dir"
done

echo "Baton/AgentPeek Bridge has been removed."
