# Kreative Koala app press/community outreach harness (Mac mini)

Finds press, reviewers, YouTubers, and newsletter/community curators who cover each app's category,
researches them, and drafts a pitch email — for all 7 apps in `apps.json`. **It never sends email.**
Leads and drafts are written into calldesktech's shared outreach tables (`product = "kreativekoala:<app>"`)
so review/approve/send reuses calldesktech's existing, tested queue and guardrails:
**review and send at https://calldesk-tech.fly.dev/admin/outreach/queue** (pick the app from the dropdown).

Uses the `claude` CLI on the mini (OAuth, no API key), same as the Calldesk and SimplyApply harnesses.

## Control
- Stop everything now:  `touch ~/.kreativekoala-outreach/STOP`   (resume: `rm` it)
- Run once now:         `launchctl kickstart gui/$(id -u)/com.kreativekoala.app-outreach`
- Run just one app:     add `OUTREACH_APP_KEY=voxkey` (see apps.json for keys) to the env file, or
                        `OUTREACH_APP_KEY=voxkey ./node_modules/.bin/tsx harness/app-outreach/run.ts`
- Dry run (no writes):  `set -a && . ~/.kreativekoala-outreach/env && set +a && DRY_RUN=1 ./node_modules/.bin/tsx harness/app-outreach/run.ts`
- Logs / history:       `~/.kreativekoala-outreach/logs/`, `~/.kreativekoala-outreach/runs.jsonl`
- Uninstall:            `launchctl bootout gui/$(id -u)/com.kreativekoala.app-outreach && rm ~/Library/LaunchAgents/com.kreativekoala.app-outreach.plist`

## Burst window vs. steady state
The plist ships set to run **hourly** (`StartInterval`), because it was set up specifically to spend a
window of otherwise-idle Claude quota across all 7 apps at once. Once that's done, or the daily-draft
ceiling (`OUTREACH_MAX_PENDING_DRAFTS`) is consistently hit, switch it to once a day like the other two
mini harnesses: edit `com.kreativekoala.app-outreach.plist.template`'s `StartInterval` block to a
`StartCalendarInterval` (see calldesktech's `harness/outreach/*.plist.template` for the exact shape),
then rerun `setup.sh`.

## Limits (enforced in code, `src/pipeline.ts` / `harness/app-outreach/run.ts`)
per app per run: <=6 search queries, <=15 enrichments, <=10 researched, <=2 drafted (all overridable) -
drafting stops once `OUTREACH_MAX_PENDING_DRAFTS` (default 40, shared across every product) unreviewed
drafts are waiting - a 45-minute deadline per run (`OUTREACH_DEADLINE_MIN`) - skips under 400 MB free
disk - lock prevents overlapping runs - a lead/domain is never re-added or re-drafted for the same app.

## Env (`~/.kreativekoala-outreach/env`, chmod 600)
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (calldesktech's project — leads/messages land in its tables),
optional `OUTREACH_SEARCH_QUERIES_PER_APP`, `OUTREACH_ENRICH_LIMIT_PER_APP`, `OUTREACH_RESEARCH_LIMIT_PER_APP`,
`OUTREACH_DRAFT_LIMIT_PER_APP`, `OUTREACH_MAX_PENDING_DRAFTS`, `OUTREACH_DEADLINE_MIN`, `OUTREACH_APP_KEY`.

Sending needs calldesktech's Fly app to have `OUTREACH_FROM_EMAIL_KK` and `OUTREACH_POSTAL_ADDRESS_KK`
set (Kreative Koala LLC's own sender identity and postal address) — separate from Calldesk's own
`OUTREACH_FROM_EMAIL`/`OUTREACH_POSTAL_ADDRESS`, and separate per-product daily send cap via
`OUTREACH_DAILY_CAP_KK` (falls back to 20/day if unset).
