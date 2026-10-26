import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';
import { loadApps } from '../../src/apps';
import { runAppDiscovery } from '../../src/pipeline';

// One bounded discovery pass across ALL configured apps (apps.json), invoked
// by launchd. Loops every app so quota is spent broadly across the whole
// portfolio rather than draining on one app first. Same guard shape as the
// calldesktech and SimplyApply Mac mini harnesses:
//   STOP file      -> run nothing (touch ~/.kreativekoala-outreach/STOP)
//   hard ceilings  -> per-app enrich/research/draft caps, plus a shared
//                     pending-drafts ceiling across all products
//   soft deadline  -> winds down cleanly (default 45 min; override for the
//                     "spend quota now" burst window via OUTREACH_DEADLINE_MIN)
//   disk floor     -> skips if under 400 MB free
// Sending stays a manual approval in calldesktech's /admin/outreach/queue
// (product filter) — this harness only ever creates leads and drafts.

const BASE = join(homedir(), '.kreativekoala-outreach');
const STOP = join(BASE, 'STOP');
const RUNS = join(BASE, 'runs.jsonl');
const MIN_FREE_MB = 400;
const dryRun = process.env.DRY_RUN === '1';

const clamp = (v: unknown, max: number, fallback: number) => {
  const n = Number(v);
  return Math.min(max, Math.max(0, Number.isFinite(n) ? Math.floor(n) : fallback));
};

function freeMb(): number {
  try { return Math.floor(Number(execSync("df -k / | awk 'NR==2 {print $4}'").toString().trim()) / 1024); } catch { return Infinity; }
}

async function main(): Promise<number> {
  mkdirSync(BASE, { recursive: true });
  const stamp = new Date().toISOString();
  if (existsSync(STOP)) { console.log(`[${stamp}] STOP file present, not running`); return 0; }
  const free = freeMb();
  if (free < MIN_FREE_MB) { console.error(`[${stamp}] only ${free} MB free (< ${MIN_FREE_MB}), skipping run`); return 2; }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set'); return 2; }

  const startedAt = Date.now();
  const deadlineMs = clamp(process.env.OUTREACH_DEADLINE_MIN, 120, 45) * 60_000;
  const stop = () => existsSync(STOP) || Date.now() - startedAt > deadlineMs;

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const apps = loadApps();
  const only = process.env.OUTREACH_APP_KEY; // for testing one app at a time
  // Each app's search/enrich/research/draft stages can take several minutes
  // (LLM web-search calls with up to 5-minute timeouts, run sequentially per
  // query), and the whole cycle is bounded by a single wall-clock deadline
  // (default 45 min) rather than a per-app budget. Processing apps.json in
  // its fixed array order meant apps later in the list (scribeai,
  // meetingmind, vibebuild) were consistently starved: earlier apps
  // (voxkey, pixora, gymlog, simplyapply) always ran first and regularly
  // consumed the whole deadline, so the loop's `if (stop()) break;` guard
  // (line 65) tripped before the later apps ever got a turn — every run,
  // forever. Rotate the starting position by run/day so every app
  // periodically gets to run first and no app is permanently starved.
  const dayNumber = Math.floor(Date.now() / 86_400_000);
  const rotated = apps.length ? apps.slice(dayNumber % apps.length).concat(apps.slice(0, dayNumber % apps.length)) : apps;
  const targets = only ? rotated.filter((a) => a.key === only) : rotated;

  const opts = {
    searchQueriesPerDay: clamp(process.env.OUTREACH_SEARCH_QUERIES_PER_APP, 6, 3),
    enrichLimit: clamp(process.env.OUTREACH_ENRICH_LIMIT_PER_APP, 15, 5),
    researchLimit: clamp(process.env.OUTREACH_RESEARCH_LIMIT_PER_APP, 10, 3),
    draftLimit: clamp(process.env.OUTREACH_DRAFT_LIMIT_PER_APP, 10, 2),
    dryRun,
    shouldStop: stop,
  };

  const results = [];
  for (const app of targets) {
    if (stop()) { console.log('deadline/STOP reached, winding down'); break; }
    console.log(`[${new Date().toISOString()}] --- ${app.name} (${app.key}) ---`);
    try {
      const summary = await runAppDiscovery(db, app, opts);
      results.push(summary);
      console.log(JSON.stringify(summary));
    } catch (error) {
      console.error(`app ${app.key} crashed:`, error);
      results.push({ app: app.key, crashed: true, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const line = { at: stamp, dryRun, seconds: Math.round((Date.now() - startedAt) / 1000), apps: results };
  appendFileSync(RUNS, JSON.stringify(line) + '\n');
  console.log(JSON.stringify(line, null, 1));
  return results.some((r) => 'crashed' in r) ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((error) => { console.error('harness crashed:', error); process.exit(1); });
