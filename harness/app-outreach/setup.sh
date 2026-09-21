#!/bin/bash
# Idempotent installer, run ON the Mac mini. Sparse-clones only what the
# harness needs, installs its dependencies, and (re)loads the launch agent.
set -euo pipefail
BASE="$HOME/.kreativekoala-outreach"; ROOT="$HOME/kreativekoala-outreach-harness"; LABEL=com.kreativekoala.app-outreach
export PATH="/opt/homebrew/bin:/usr/bin:/bin"
mkdir -p "$BASE/logs" "$ROOT"
[ -d "$ROOT/repo/.git" ] || git clone -q --depth 1 https://github.com/tsushanth/kreativekoala-app-outreach.git "$ROOT/repo"
cd "$ROOT/repo"
git pull -q --ff-only
npm install --no-audit --no-fund --loglevel=error
[ -f "$BASE/env" ] || { echo "missing $BASE/env (see README.md)"; exit 1; }
chmod 600 "$BASE/env"
sed "s|__HOME__|$HOME|g" harness/app-outreach/com.kreativekoala.app-outreach.plist.template > "$HOME/Library/LaunchAgents/$LABEL.plist"
U=$(id -u); launchctl bootout gui/$U/$LABEL 2>/dev/null || true
launchctl bootstrap gui/$U "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "installed and loaded $LABEL (hourly burst window; see README.md to switch to daily afterward)"
