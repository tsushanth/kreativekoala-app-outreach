#!/usr/bin/env tsx
/**
 * Bulk-qualify pipeline: for every lead in calldesk_outreach_leads that has a
 * contact email and no dossier (researched_at IS NULL), fetch the homepage,
 * run the research prompt, and write the dossier + fit back.
 *
 * This is the single biggest win: 95,642 leads already have emails. Search is
 * done; qualification is cheap (one HTTP fetch + one LLM call per lead).
 *
 * Usage (from harness/app-outreach/):
 *   ../../node_modules/.bin/tsx ../../src/qualify.ts
 *
 * Env:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY   – required
 *   OPENROUTER_API_KEY                   – required
 *   OUTREACH_QUALIFY_BATCH              – leads per run (default 50)
 *   OUTREACH_QUALIFY_APP                – only one app key, or omit for ALL
 *   OUTREACH_DEADLINE_MIN               – soft timeout (default 45)
 *   DRY_RUN                             – read only, no writes
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { apiComplete, extractJson } from './llm';
import { hostOf } from './findDomain';
import type { AppConfig } from './apps';
import { productFor } from './apps';
import { loadApps } from './apps';

const BASE = join(homedir(), '.kreativekoala-outreach');
const STOP = join(BASE, 'STOP');
const RUNS = join(BASE, 'qualify.jsonl');

const BATCH = clampInt(process.env.OUTREACH_QUALIFY_BATCH, 200, 50);
const DEADLINE_MS = clampInt(process.env.OUTREACH_DEADLINE_MIN, 120, 45) * 60_000;
const CONCURRENCY = clampInt(process.env.OUTREACH_QUALIFY_CONCURRENCY, 8, 4);
const FETCH_TIMEOUT = clampInt(process.env.OUTREACH_FETCH_TIMEOUT, 30_000, 12_000);
const MAX_SITE_CHARS = clampInt(process.env.OUTREACH_MAX_SITE_CHARS, 20_000, 8_000);
const dryRun = process.env.DRY_RUN === '1';
const ONLY_APP = process.env.OUTREACH_QUALIFY_APP || '';

function clampInt(v: string | undefined, max: number, fallback: number) {
  const n = Number(v);
  return Math.min(max, Math.max(0, Number.isFinite(n) ? Math.floor(n) : fallback));
}

/* ------------------------------------------------------------------ */
// Types matching the pipeline.ts LeadRow
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
  research: unknown;
  researched_at: string | null;
  fit: string | null;
}

interface FitResult {
  sources: string[];
  summary: string;
  covers: string[];
  fit: string;
  fit_reason: string;
  hook: string | null;
}

/* ------------------------------------------------------------------ */
// HTTP fetch helper
const DISCOVERY_UA = 'Mozilla/5.0 (compatible; kreativekoala-outreach-research/1.0; +https://kreativekoala.llc)';

async function politeFetchText(url: string, timeoutMs: number): Promise<{ ok: boolean; text: string; status: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': DISCOVERY_UA, Accept: 'text/html,text/plain' },
      signal: controller.signal,
      redirect: 'follow',
    });
    const text = res.ok ? await res.text() : '';
    return { ok: res.ok, text: text.slice(0, 1_500_000), status: res.status };
  } catch {
    return { ok: false, text: '', status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
// Research LLM call (adapted from research.ts but async, using apiComplete)

// Stricter pre-filter: only even call the LLM if the page looks like it could be a media outlet.
const LOOKS_LIKE_MEDIA = /\b(blog|editor|press|news|review|writer|journalist|magazine|podcast|newsletter|youtuber|channel|subscribe|about us|contact us|write for us|submission|guest post|media kit|press kit|coverage|interview|spotlight|feature)\b/i;
const MUST_NOT_BE = /\b(app store|google play|download now|buy now|shopping cart|checkout|pricing|demo request|get started free|sign up|login|terms of service|privacy policy)\b/i;

function makeResearchPrompt(siteText: string, lead: LeadRow, app: AppConfig): string {
  const name = lead.company_name;
  const domain = lead.domain || '';
  const desc = lead.description || '';
  const text = (siteText || '').slice(0, MAX_SITE_CHARS);

  return `You are researching whether a media outlet, blogger, YouTuber or newsletter would be a good fit to tell their audience about a new Android app.

App: ${app.name} — ${app.oneLiner}
Contact: ${name}
Website: https://${domain}
${desc ? `Listing blurb: ${desc}\n` : ''}
Here is the text of their homepage (truncated):
---
${text}
---

Return ONLY a JSON object with these keys:
- summary: 1-2 factual sentences on what this outlet/creator covers
- covers: array of up to 6 short topics/categories they actually cover
- fit: "high" if they clearly cover this app's category (${app.category}) and review/mention apps; "medium" if adjacent (general tech/productivity) and plausible; "low" if unrelated or no sign they cover apps/reviews at all; "unclear" if the site could not be read
- fit_reason: one sentence
- hook: ONE specific, verifiable qualitative detail from their site worth mentioning in an email (a recent post/video topic, a stated focus, a submission policy), or null
- sources: array containing ONLY the URL "https://${domain}" (no other sources, since we only read the homepage)

No commentary, no markdown fences.`;
}

async function researchLead(lead: LeadRow, app: AppConfig): Promise<FitResult | null> {
  const domain = lead.domain;
  if (!domain) return null;

  const url = `https://${domain}`;
  const fetched = await politeFetchText(url, FETCH_TIMEOUT);
  if (!fetched.ok || fetched.text.length < 500) {
    // Site unreachable or too short to judge — mark unclear so we don't keep retrying
    return {
      sources: [],
      summary: '',
      covers: [],
      fit: 'unclear',
      fit_reason: 'Site could not be read or was too short',
      hook: null,
    };
  }

  // Quick guard: if the homepage doesn't look like media at all, or looks like a product/app store page, skip the LLM call.
  const looksMedia = LOOKS_LIKE_MEDIA.test(fetched.text.slice(0, 200_000));
  const looksProduct = MUST_NOT_BE.test(fetched.text.slice(0, 200_000));
  if (!looksMedia || looksProduct) {
    return {
      sources: [url],
      summary: '',
      covers: [],
      fit: 'low',
      fit_reason: looksProduct ? 'Homepage looks like a product/app store page, not media' : 'Homepage does not appear to be a media outlet, blog, or creator site',
      hook: null,
    };
  }

  const prompt = makeResearchPrompt(fetched.text, lead, app);
  const text = await apiComplete(prompt, {
    model: process.env.OUTREACH_CLI_MODEL || 'google/gemini-2.0-flash-001',
    maxTokens: 2048,
    timeoutMs: 60_000,
  });
  const parsed = extractJson<unknown>(text, 'object');
  if (!parsed || typeof parsed !== 'object') return null;

  const p = parsed as Record<string, unknown>;
  const fit = typeof p.fit === 'string' ? p.fit : 'unclear';
  const sources = Array.isArray(p.sources) ? p.sources.filter((s): s is string => typeof s === 'string') : [];

  return {
    sources,
    summary: typeof p.summary === 'string' ? p.summary.trim().slice(0, 400) : '',
    covers: (Array.isArray(p.covers) ? p.covers : []).filter((c): c is string => typeof c === 'string').slice(0, 6),
    fit: ['high', 'medium', 'low', 'unclear'].includes(fit) ? fit : 'unclear',
    fit_reason: typeof p.fit_reason === 'string' ? p.fit_reason.trim().slice(0, 300) : '',
    hook: typeof p.hook === 'string' && p.hook.trim() ? p.hook.trim().slice(0, 240) : null,
  };
}

/* ------------------------------------------------------------------ */
// Batch worker with concurrency cap

async function runBatch<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<{ results: R[]; errors: Array<{ item: T; error: string }> }> {
  const queue = [...items];
  const results: R[] = [];
  const errors: Array<{ item: T; error: string }> = [];

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift()!;
      try {
        const r = await fn(item);
        results.push(r);
      } catch (err) {
        errors.push({ item, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { results, errors };
}

/* ------------------------------------------------------------------ */
// Main

async function main(): Promise<number> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set');
    return 2;
  }
  if (!process.env.OPENROUTER_API_KEY && !process.env.CLAUDE_BIN) {
    console.error('OPENROUTER_API_KEY not set (and CLAUDE_BIN not set for fallback)');
    return 2;
  }
  if (existsSync(STOP)) {
    console.log(`[${new Date().toISOString()}] STOP file present, not running`);
    return 0;
  }

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const apps = loadApps();
  const appMap = new Map(apps.map((a) => [productFor(a), a]));

  const startedAt = Date.now();
  const shouldStop = () => existsSync(STOP) || Date.now() - startedAt > DEADLINE_MS;

  // Build app filter
  const appFilter = ONLY_APP ? apps.filter((a) => a.key === ONLY_APP).map(productFor) : Array.from(appMap.keys());
  if (ONLY_APP && appFilter.length === 0) {
    console.error(`No app found matching OUTREACH_QUALIFY_APP=${ONLY_APP}`);
    return 2;
  }

  // For each app, pull unqualified leads with emails
  const toProcess: Array<{ lead: LeadRow; app: AppConfig }> = [];
  for (const product of appFilter) {
    if (shouldStop()) break;
    const { data: rows, error } = await db
      .from('calldesk_outreach_leads')
      .select('*')
      .eq('product', product)
      .eq('contact_status', 'found')
      .eq('region_blocked', false)
      .eq('status', 'new')
      .is('researched_at', null)
      .not('domain', 'is', null)
      .limit(BATCH);

    if (error) {
      console.error(`[${product}] query error: ${error.message}`);
      continue;
    }
    const app = appMap.get(product);
    if (!app) continue;
    for (const lead of (rows ?? []) as LeadRow[]) {
      toProcess.push({ lead, app });
    }
  }

  console.log(`[${new Date().toISOString()}] ${toProcess.length} leads to qualify (batch=${BATCH}, concurrency=${CONCURRENCY})`);
  if (toProcess.length === 0) {
    console.log('No leads to process.');
    return 0;
  }

  // Run qualification concurrently
  let processed = 0;
  let failed = 0;
  let highFit = 0;
  let mediumFit = 0;
  let lowFit = 0;
  let unclearFit = 0;

  const { errors } = await runBatch(toProcess, CONCURRENCY, async ({ lead, app }) => {
    if (shouldStop()) throw new Error('STOP/deadline reached');
    try {
      const dossier = await researchLead(lead, app);
      if (!dossier) {
        failed++;
        return;
      }
      processed++;
      if (dossier.fit === 'high') highFit++;
      else if (dossier.fit === 'medium') mediumFit++;
      else if (dossier.fit === 'low') lowFit++;
      else unclearFit++;

      if (dryRun) {
        console.log(`[DRY ${lead.company_name}] fit=${dossier.fit} reason="${dossier.fit_reason}" hook="${dossier.hook ?? ''}"`);
        return;
      }

      await db.from('calldesk_outreach_leads').update({
        research: dossier,
        researched_at: new Date().toISOString(),
        fit: dossier.fit,
        ...(dossier.fit === 'low' ? { status: 'dead', signal_detail: `Low fit: ${dossier.fit_reason}`.slice(0, 300) } : {}),
      }).eq('id', lead.id);
    } catch (err) {
      failed++;
      console.error(`[${lead.company_name}] ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  const summary = {
    at: new Date().toISOString(),
    dryRun,
    batchSize: BATCH,
    concurrency: CONCURRENCY,
    app: ONLY_APP || 'all',
    processed,
    failed: failed + errors.length,
    fits: { high: highFit, medium: mediumFit, low: lowFit, unclear: unclearFit },
    deadlineReached: Date.now() - startedAt > DEADLINE_MS,
    seconds: Math.round((Date.now() - startedAt) / 1000),
  };

  const fs = await import('fs');
  fs.appendFileSync(RUNS, JSON.stringify(summary) + '\n');
  console.log(JSON.stringify(summary, null, 1));
  return summary.failed > 0 ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(e);
  process.exit(1);
});
