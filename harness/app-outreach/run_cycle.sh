#!/bin/bash
# Launched by launchd. Wraps run.ts with a lock, kill switch, code update,
# per-run log, log pruning and a notification on failure.
export PATH="$HOME/.claude-accounts/bin:/opt/homebrew/bin:/usr/bin:/bin"
export HOME="${HOME:-/Users/$(id -un)}"
set -uo pipefail

BASE="$HOME/.kreativekoala-outreach"
REPO="$HOME/kreativekoala-outreach-harness/repo"
mkdir -p "$BASE/logs"
LOG="$BASE/logs/run_$(date +%Y%m%d_%H%M%S).log"

[ -f "$BASE/STOP" ] && { echo "$(date) STOP file present, not running" >> "$BASE/logs/skipped.log"; exit 0; }

LOCK="$BASE/lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  PID=$(cat "$LOCK/pid" 2>/dev/null || echo 0)
  if kill -0 "$PID" 2>/dev/null; then echo "$(date) previous run still active (pid $PID), skipping" >> "$BASE/logs/skipped.log"; exit 0; fi
  rm -rf "$LOCK"; mkdir "$LOCK"
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

set -a; . "$BASE/env"; set +a

( cd "$REPO" && git pull -q --ff-only ) >> "$LOG" 2>&1 || echo "git pull failed; using existing code" >> "$LOG"

cd "$REPO/harness/app-outreach" || exit 1
../../node_modules/.bin/tsx run.ts >> "$LOG" 2>&1
RC=$?

find "$BASE/logs" -name 'run_*.log' -mtime +30 -delete 2>/dev/null
[ $RC -ne 0 ] && osascript -e 'display notification "App-outreach run failed. See ~/.kreativekoala-outreach/logs" with title "Kreative Koala outreach"' 2>/dev/null
exit $RC
