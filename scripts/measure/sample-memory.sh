#!/usr/bin/env bash
# Workflow plan 36: sample the editor's memory at each budgets-bench checkpoint (see README.md in this folder).
#
# Usage: scripts/measure/sample-memory.sh <tauri dev log> <file listing WebKit pids from before the launch>
#
# Waits for `[photobook:bench] checkpoint <name>` lines in the log; 15 s into each hold it reads the physical footprint
# (what Activity Monitor calls Memory) and the RSS of `photobook-editor` and of every WebKit process that was not
# running before the launch (the window's WebContent, GPU and Networking processes). Stops at `done` or `failed`.
set -u
log=$1
before=$2
settle=${SETTLE_SECONDS:-15}
seen=" "

footprint_bytes() {
  footprint --noCategories -f bytes -p "$1" 2>/dev/null | sed -n 's/.*Footprint: \([0-9]*\) B.*/\1/p' | head -1
}

sample() {
  local name=$1 total=0 rss_total=0 line=""
  local editor
  # Match the binary's path: macOS truncates process names, and a bare pattern would match shells quoting it.
  editor=$(pgrep -f '/photobook-editor$' | head -1)
  local pids="$editor"
  for pid in $(pgrep -f 'XPCServices/com.apple.WebKit' 2>/dev/null); do
    grep -qx "$pid" "$before" || pids="$pids $pid"
  done
  for pid in $pids; do
    local fp rss comm
    fp=$(footprint_bytes "$pid")
    rss=$(ps -o rss= -p "$pid" | tr -d ' ')
    comm=$(ps -o comm= -p "$pid" | sed 's#.*/##')
    total=$((total + ${fp:-0}))
    rss_total=$((rss_total + ${rss:-0}))
    line="$line $comm[$pid]=$(( ${fp:-0} / 1048576 ))MB"
  done
  echo "[measure] checkpoint $name footprint_total=$(( total / 1048576 ))MB rss_total=$(( rss_total / 1024 ))MB |$line"
}

while true; do
  if grep -q '\[photobook:bench\] \(done\|failed\)' "$log" 2>/dev/null; then
    grep '\[photobook:bench\] \(done\|failed\)' "$log" | head -1
    break
  fi
  for name in $(grep -o '\[photobook:bench\] checkpoint [a-z]*' "$log" 2>/dev/null | awk '{print $3}'); do
    case "$seen" in *" $name "*) continue ;; esac
    seen="$seen$name "
    sleep "$settle"
    sample "$name"
  done
  sleep 2
done
