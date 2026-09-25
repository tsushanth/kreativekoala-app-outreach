# Kreative Koala app press/community outreach harness (Mac mini)

Finds press, reviewers, YouTubers, and newsletter/community curators who cover each app's category,
researches them, and drafts a pitch email — for all 7 apps in `apps.json`. **It never sends email.**
Leads and drafts are written into calldesktech's shared outreach tables (`product = "kreativekoala:<app>"`)
so review/approve/send reuses calldesktech's existing, tested queue and guardrails:
**review and send at https://calldesk-tech.fly.dev/admin/outreach/queue** (pick the app from the dropdown).

Uses the **OpenRouter API** (Claude via OpenRouter) on the mini. Set `OPENROUTER_API_KEY` in the env file.
The old `claude` CLI fallback is still supported if the API key is absent (set `CLAUDE_BIN` if it's not on PATH).

## Control
- Stop everything now:  `touch ~/.kreativekoala-outreach/STOP`   (resume: `rm` it)
- Run qualify once:     `launchctl kickstart gui/$(id -u)/com.kreativekoala.app-outreach`
- Run just one app:     add `OUTREACH_QUALIFY_APP=voxkey` to the env file
- Dry run (no writes):  `set -a && . ~/.kreativekoala-outreach/env && set +a && DRY_RUN=1 ../../node_modules/.bin/tsx src/qualify.ts`
- Logs / history:       `~/.kreativekoala-outreach/logs/`, `~/.kreativekoala-outreach/qualify.jsonl`
- Uninstall:            `launchctl bootout gui/$(id -u)/com.kreativekoala.app-outreach && rm ~/Library/LaunchAgents/com.kreativekoala.app-outreach.plist`

## Burst window vs. steady state
The plist is set to run **once a day** at 09:13 (`StartCalendarInterval`).
If you want to spend quota faster, switch to `StartInterval` (e.g. 1800 for every 30 min),
edit the plist template, then rerun `setup.sh`.

## Limits (enforced in `src/qualify.ts`)
per run: `OUTREACH_QUALIFY_BATCH` leads (default 50, max 200) — `OUTREACH_QUALIFY_CONCURRENCY` parallel
workers (default 4, max 8) — `OUTREACH_FETCH_TIMEOUT` per-site fetch (default 12 s, max 30 s) —
`OUTREACH_DEADLINE_MIN` soft timeout per run (default 45 min) — skips under 400 MB free disk — lock
prevents overlapping runs.

A lead is never re-qualified: `researched_at IS NULL` is the guard. Low-fit leads are marked `dead`
so they are never drafted.

## Env (`~/.kreativekoala-outreach/env`, chmod 600)
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `OPENROUTER_API_KEY` (required — get from openrouter.ai/keys).
Optional: `OUTREACH_QUALIFY_BATCH`, `OUTREACH_QUALIFY_CONCURRENCY`, `OUTREACH_FETCH_TIMEOUT`,
`OUTREACH_MAX_SITE_CHARS` (default 8000, max 20000 — how much of the homepage to send to the LLM),
`OUTREACH_DEADLINE_MIN`, `OUTREACH_QUALIFY_APP` (single app key), `OUTREACH_CLI_MODEL`
(default `google/gemini-2.0-flash-001`; also good: `openai/gpt-4o-mini`, `anthropic/claude-3.5-haiku`).

If `OPENROUTER_API_KEY` is absent, the harness falls back to the `claude` CLI (set `CLAUDE_BIN` if
it's not on PATH, e.g. `CLAUDE_BIN=/Users/you/.local/bin/claude`).
