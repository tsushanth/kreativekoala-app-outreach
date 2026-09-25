#!/bin/bash
# Launched by launchd. Wraps run.ts with a lock, kill switch, code update,
# per-run log, log pruning and a notification on failure.
# $HOME/.local/bin is where the `claude` CLI actually lives now; the old
# $HOME/.claude-accounts/bin no longer exists. This harness is CLI-only
# (src/llm.ts has no API-key fallback), so if `claude` is not on PATH every run
# dies with "claude CLI failed to run" before it reaches the database. launchd
# also starts with a minimal PATH, so it must be set here rather than inherited.
export PATH="$HOME/.local/bin:$HOME/.claude-accounts/bin:/opt/homebrew/bin:/usr/bin:/bin"
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

# Fail fast and loudly if the one hard dependency is missing, instead of letting
# tsx die with an opaque spawnSync ENOENT and burning the run.
if ! command -v claude >/dev/null 2>&1; then
  echo "$(date) FATAL: 'claude' not on PATH ($PATH) — this harness is CLI-only" >> "$LOG"
  osascript -e 'display notification "claude CLI not found on PATH. See ~/.kreativekoala-outreach/logs" with title "Kreative Koala outreach"' 2>/dev/null
  exit 3
fi

( cd "$REPO" && git pull -q --ff-only ) >> "$LOG" 2>&1 || echo "git pull failed; using existing code" >> "$LOG"

cd "$REPO/harness/app-outreach" || exit 1
../../node_modules/.bin/tsx run.ts >> "$LOG" 2>&1
RC=$?

find "$BASE/logs" -name 'run_*.log' -mtime +30 -delete 2>/dev/null
[ $RC -ne 0 ] && osascript -e 'display notification "App-outreach run failed. See ~/.kreativekoala-outreach/logs" with title "Kreative Koala outreach"' 2>/dev/null
exit $RC
