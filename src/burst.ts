#!/usr/bin/env tsx
/**
 * Burst mode: research + draft in one pass, no discovery.
 *
 * For each app, finds leads that already have emails but no dossier.
 * For each lead: research (fetch site + LLM), then if not low-fit,
 * draft immediately. Writes both the dossier and the draft to Supabase
 * before moving on, so a crash loses no more than one lead's work.
 *
 * Stops when any of:
 *   - OUTREACH_BURST_DRAFT_TARGET drafts created (default 60)
 *   - OUTREACH_MAX_PENDING_DRAFTS ceiling hit
 *   - OUTREACH_DEADLINE_MIN reached
 *   - STOP file present
 *   - no more unqualified leads
 *   - rate limit or other LLM error (logs, exits cleanly for relaunch)
 *
 * Usage:
 *   ../../node_modules/.bin/tsx src/burst.ts
 *
 * Env:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, OPENROUTER_API_KEY (or CLAUDE_BIN)
 *   OUTREACH_BURST_DRAFT_TARGET  – per-run target (default 60)
 *   OUTREACH_BURST_DRAFTS_PER_APP – max per app per run (default 15)
 *   OUTREACH_BURST_LEADS_PER_APP  – max leads to attempt per app (default 30)
 *   OUTREACH_MAX_PENDING_DRAFTS   – shared ceiling (default 40)
 *   OUTREACH_DEADLINE_MIN         – soft timeout (default 90)
 *   OUTREACH_APP_KEY              – single app only, or omit for all
 *   OUTREACH_RESEARCH             – '0' to skip research (blind draft; risky)
 *   DRY_RUN                       – read only, no writes
 */
import { existsSync } from 'fs';
import { appendFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AppConfig } from './apps';
import { productFor, loadApps, publicName, publicUrl } from './apps';
import { politeFetchText, DISCOVERY_UA } from './http';
import { apiComplete, extractJson } from './llm';
import { researchContact, normalizeDossier, type Dossier } from './research';
import { draftPitchEmail } from './draft';

// --- config ---
const BASE = join(homedir(), '.kreativekoala-outreach');
const STOP = join(BASE, 'STOP');
const LOG = join(BASE, 'burst.jsonl');
const DRY_RUN = process.env.DRY_RUN === '1';

const DRAFT_TARGET = clampInt(process.env.OUTREACH_BURST_DRAFT_TARGET, 500, 60);
const DRAFTS_PER_APP = clampInt(process.env.OUTREACH_BURST_DRAFTS_PER_APP, 100, 15);
const LEADS_PER_APP = clampInt(process.env.OUTREACH_BURST_LEADS_PER_APP, 200, 30);
const MAX_PENDING = clampInt(process.env.OUTREACH_MAX_PENDING_DRAFTS, 300, 40);
const DEADLINE_MS = clampInt(process.env.OUTREACH_DEADLINE_MIN, 180, 90) * 60_000;
const ONLY_APP = process.env.OUTREACH_APP_KEY || '';
const RESEARCH_ON = process.env.OUTREACH_RESEARCH !== '0';

function clampInt(v: string | undefined, max: number, fallback: number) {
  const n = Number(v);
  return Math.min(max, Math.max(0, Number.isFinite(n) ? Math.floor(n) : fallback));
}

// --- db types ---
interface LeadRow {
  id: string;
  product: string;
  company_name: string;
  domain: string | null;
  description: string | null;
  location: string | null;
  contact_email: string | null;
  contact_status: string | null;
  region_blocked: boolean;
  status: string;
  research: Dossier | null;
  researched_at: string | null;
  fit: string | null;
}

interface RunSummary {
  at: string;
  dry: boolean;
  seconds: number;
  apps: Array<{
    app: string;
    attempted: number;
    researched: number;
    drafted: number;
    lowFit: number;
    errors: string[];
  }>;
  totalDrafted: number;
  stopped: string; // reason
}

// --- one lead: research then draft ---
async function processLead(
  db: SupabaseClient<any>,
  lead: LeadRow,
  app: AppConfig,
  appSummary: { attempted: number; researched: number; drafted: number; lowFit: number; errors: string[] },
  globalPending: number,
  stop: () => boolean,
): Promise<boolean> {
  if (stop()) return false;
  const now = new Date().toISOString();
  appSummary.attempted++;

  let dossier: Dossier | null = lead.research;

  // 1. Research if needed
  if (!dossier && RESEARCH_ON && lead.domain) {
    try {
      dossier = researchContact(
        { name: lead.company_name, domain: lead.domain, description: lead.description },
        app,
      );
      appSummary.researched++;

      if (dossier.fit === 'low') appSummary.lowFit++;

      if (!DRY_RUN) {
        await db.from('calldesk_outreach_leads').update({
          research: dossier,
          researched_at: now,
          fit: dossier.fit,
          ...(dossier.fit === 'low' ? { status: 'dead', signal_detail: `Low fit: ${dossier.fit_reason}`.slice(0, 300) } : {}),
        }).eq('id', lead.id);
      }
    } catch (err) {
      const msg = `research ${lead.company_name}: ${err instanceof Error ? err.message : String(err)}`;
      appSummary.errors.push(msg);
      return true; // keep going with other leads
    }
  }

  // 2. Skip dead/unclear leads (unless we skip research entirely)
  if (RESEARCH_ON && (!dossier || dossier.fit === 'low')) return true;

  // 3. Draft
  if (globalPending >= MAX_PENDING) return false; // stop app loop

  const email = (lead.contact_email ?? '').toLowerCase();
  if (!email) return true;

  try {
    const draft = draftPitchEmail(
      { contactName: lead.company_name, domain: lead.domain, location: lead.location, description: lead.description, dossier: dossier ?? undefined },
      app,
    );

    if (!DRY_RUN) {
      // Check for pending cap again right before insert (race)
      const { count } = await db.from('calldesk_outreach_messages')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'draft');
      if ((count ?? 0) >= MAX_PENDING) return false;

      const { error: insErr } = await db.from('calldesk_outreach_messages').insert({
        lead_id: lead.id,
        to_email: email,
        subject: draft.subject,
        body_text: draft.body,
        status: 'draft',
        product: lead.product,
        sources: dossier?.sources ?? [],
      });
      if (insErr) throw new Error(insErr.message);

      await db.from('calldesk_outreach_leads').update({
        status: 'report_generated',
        updated_at: now,
      }).eq('id', lead.id);
    }

    appSummary.drafted++;
    console.log(`[${lead.product}] drafted: ${lead.company_name} <${email}>`);
    return true;
  } catch (err) {
    const msg = `draft ${lead.company_name}: ${err instanceof Error ? err.message : String(err)}`;
    appSummary.errors.push(msg);
    // If it's a rate limit, stop this app entirely so we can relaunch later
    const isRateLimit = /rate.?limit|429|quota|Too Many Requests/i.test(msg);
    return !isRateLimit; // false = stop app loop
  }
}

// --- main ---
async function main(): Promise<number> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY');
    return 2;
  }
  if (existsSync(STOP)) {
    console.log(`[${new Date().toISOString()}] STOP file present`);
    return 0;
  }

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });

  const apps = loadApps();
  const targets = ONLY_APP ? apps.filter((a) => a.key === ONLY_APP) : apps;
  if (ONLY_APP && targets.length === 0) {
    console.error(`No app matching OUTREACH_APP_KEY=${ONLY_APP}`);
    return 2;
  }

  const startedAt = Date.now();
  const stop = () => existsSync(STOP) || Date.now() - startedAt > DEADLINE_MS;

  // How many pending drafts exist right now?
  const { count: pendingRaw } = await db.from('calldesk_outreach_messages')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'draft');
  let globalPending = pendingRaw ?? 0;

  if (globalPending >= MAX_PENDING) {
    console.log(`Already at pending cap ${globalPending}/${MAX_PENDING}. Nothing to do.`);
    return 0;
  }

  let totalDrafted = 0;
  const appResults: RunSummary['apps'] = [];
  let stoppedBecause = 'completed';

  for (const app of targets) {
    if (stop()) { stoppedBecause = 'deadline/STOP'; break; }
    if (totalDrafted >= DRAFT_TARGET) { stoppedBecause = 'draft target hit'; break; }
    if (globalPending >= MAX_PENDING) { stoppedBecause = 'pending cap'; break; }

    const product = productFor(app);
    const summary = { app: app.key, attempted: 0, researched: 0, drafted: 0, lowFit: 0, errors: [] };

    // Pull unqualified leads with emails
    let query = db.from('calldesk_outreach_leads')
      .select('*')
      .eq('product', product)
      .eq('contact_status', 'found')
      .eq('region_blocked', false)
      .eq('status', 'new')
      .not('domain', 'is', null)
      .not('contact_email', 'is', null)
      .limit(LEADS_PER_APP);

    // If we already have research on some, prefer un-researched
    if (RESEARCH_ON) {
      query = query.is('researched_at', null);
    }

    const { data: rows, error } = await query;
    if (error) {
      console.error(`[${app.key}] query error: ${error.message}`);
      summary.errors.push(`query: ${error.message}`);
      appResults.push(summary);
      continue;
    }

    const leads = (rows ?? []) as LeadRow[];
    console.log(`[${app.key}] ${leads.length} leads to attempt (draft cap: ${DRAFTS_PER_APP}, global pending: ${globalPending}/${MAX_PENDING})`);

    for (const lead of leads) {
      if (stop()) { stoppedBecause = 'deadline/STOP'; break; }
      if (summary.drafted >= DRAFTS_PER_APP) { stoppedBecause = 'app draft cap'; break; }
      if (totalDrafted >= DRAFT_TARGET) { stoppedBecause = 'draft target hit'; break; }
      if (globalPending >= MAX_PENDING) { stoppedBecause = 'pending cap'; break; }

      const continueApp = await processLead(db, lead, app, summary, globalPending, stop);
      if (summary.drafted > 0) {
        totalDrafted++;
        globalPending++;
      }
      if (!continueApp) {
        stoppedBecause = 'rate limit or fatal draft error';
        break;
      }
    }

    appResults.push(summary);
    console.log(`[${app.key}] done: attempted=${summary.attempted} drafted=${summary.drafted}`);
  }

  const result: RunSummary = {
    at: new Date().toISOString(),
    dry: DRY_RUN,
    seconds: Math.round((Date.now() - startedAt) / 1000),
    apps: appResults,
    totalDrafted,
    stopped: stoppedBecause,
  };

  appendFileSync(LOG, JSON.stringify(result) + '\n');
  console.log(JSON.stringify(result, null, 1));

  return appResults.some((a) => a.errors.some((e) => /rate.?limit|429/i.test(e))) ? 99 : 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(e);
  process.exit(1);
});
