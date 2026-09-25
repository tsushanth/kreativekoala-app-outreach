#!/bin/bash
# launchd-friendly wrapper for qualify.ts. Same guard shape as run_cycle.sh:
# STOP file, lock, disk floor, env sourcing, and a notification on failure.
set -uo pipefail

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/bin:/bin"
export HOME="${HOME:-/Users/$(id -un)}"

BASE="$HOME/.kreativekoala-outreach"
REPO="$HOME/kreativekoala-outreach-harness/repo"
mkdir -p "$BASE/logs"
LOG="$BASE/logs/qualify_$(date +%Y%m%d_%H%M%S).log"

[ -f "$BASE/STOP" ] && { echo "$(date) STOP file present, not running" >> "$BASE/logs/skipped.log"; exit 0; }

LOCK="$BASE/qualify_lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  PID=$(cat "$LOCK/pid" 2>/dev/null || echo 0)
  if kill -0 "$PID" 2>/dev/null; then echo "$(date) previous qualify still active (pid $PID), skipping" >> "$BASE/logs/skipped.log"; exit 0; fi
  rm -rf "$LOCK"; mkdir "$LOCK"
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

set -a; . "$BASE/env"; set +a

MIN_FREE_MB=400
FREE_MB=$(df -k / | awk 'NR==2 {print int($4/1024)}')
if [ "$FREE_MB" -lt "$MIN_FREE_MB" ]; then
  echo "$(date) only ${FREE_MB}MB free (< ${MIN_FREE_MB}), skipping" >> "$LOG"
  exit 2
fi

( cd "$REPO" && git pull -q --ff-only ) >> "$LOG" 2>&1 || echo "git pull failed; using existing code" >> "$LOG"

cd "$REPO" || exit 1
../../node_modules/.bin/tsx src/qualify.ts >> "$LOG" 2>&1
RC=$?

find "$BASE/logs" -name 'qualify_*.log' -mtime +30 -delete 2>/dev/null
[ $RC -ne 0 ] && osascript -e 'display notification "Qualify run failed. See ~/.kreativekoala-outreach/logs" with title "Kreative Koala outreach"' 2>/dev/null
exit $RC
