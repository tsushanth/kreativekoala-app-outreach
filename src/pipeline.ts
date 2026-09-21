import type { SupabaseClient } from '@supabase/supabase-js';
import type { AppConfig } from './apps';
import { productFor } from './apps';
import { findSearchCandidates } from './discovery';
import { findContact } from './contactPages';
import { isBlockedDomain, isRegionBlocked } from './region';
import { LeadIndex, type LeadKeyRow } from './dedupe';
import { researchContact, type Dossier } from './research';
import { draftPitchEmail } from './draft';

// One app's discovery pass, writing into calldesktech's shared outreach tables
// (product = 'kreativekoala:<key>'). Mirrors calldesktech's discovery pipeline
// stage-by-stage (search -> enrich contact -> research -> draft), simplified:
// no directory stage (there is no directory of app reviewers), no scoring
// model (every verified, on-topic contact is worth drafting to, at this scale).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any>;

interface LeadRow extends LeadKeyRow {
  id: string;
  company_name: string;
  domain: string | null;
  status: string;
  contact_email: string | null;
  contact_status: string | null;
  region_blocked: boolean;
  description: string | null;
  location: string | null;
  research: Dossier | null;
  researched_at: string | null;
  fit: string | null;
}

export interface AppRunSummary {
  app: string;
  searchCandidates: number;
  leadsNew: number;
  contactsFound: number;
  researched: number;
  lowFit: number;
  draftsCreated: number;
  errors: string[];
}

export interface AppRunOptions {
  searchQueriesPerDay: number;
  enrichLimit: number;
  researchLimit: number;
  draftLimit: number;
  dryRun: boolean;
  shouldStop: () => boolean;
}

export async function runAppDiscovery(db: Db, app: AppConfig, opts: AppRunOptions): Promise<AppRunSummary> {
  const product = productFor(app);
  const summary: AppRunSummary = { app: app.key, searchCandidates: 0, leadsNew: 0, contactsFound: 0, researched: 0, lowFit: 0, draftsCreated: 0, errors: [] };

  const { data: existing } = await db.from('calldesk_outreach_leads').select('*').eq('product', product);
  const index = new LeadIndex<LeadRow>((existing ?? []) as LeadRow[]);

  // 1. Search for new contacts.
  const { candidates, errors, rejected } = await findSearchCandidates(app, opts.searchQueriesPerDay, opts.shouldStop);
  summary.errors.push(...errors.map((e) => `[search] ${e}`));
  summary.searchCandidates = candidates.length;
  const now = new Date().toISOString();
  const newLeads: LeadRow[] = [];

  for (const c of candidates) {
    if (index.find({ name: c.name, domain: c.domain })) continue; // already known for this app
    const blocked = isRegionBlocked(c.location, c.name) || isBlockedDomain(c.domain);
    const base = { company_name: c.name, domain: c.domain, location: c.location, description: c.blurb, region_blocked: blocked };
    if (opts.dryRun) {
      const fake = { id: `dry-${c.domain}`, status: 'new', contact_email: null, contact_status: 'unknown', research: null, researched_at: null, fit: null, ...base } as LeadRow;
      index.add(fake);
      newLeads.push(fake);
      continue;
    }
    const { data: inserted, error } = await db.from('calldesk_outreach_leads').insert({
      ...base, product, source_key: `kk:${app.key}:${c.domain}`, signal_source: 'search',
      signal_detail: `Web search for ${app.key} press contacts: ${(c.blurb ?? '').slice(0, 200)}`, last_seen_at: now,
    }).select('*').single();
    if (error) {
      // Unique-violation on (product, domain) just means it was inserted by an
      // overlapping run — not a real failure, so don't report it as an error.
      if (!/duplicate key/i.test(error.message)) summary.errors.push(`insert ${c.name}: ${error.message}`);
    } else if (inserted) {
      summary.leadsNew++;
      index.add(inserted as LeadRow);
      newLeads.push(inserted as LeadRow);
    }
  }
  if (rejected.length) summary.errors.push(`[search] rejected as non-media: ${rejected.slice(0, 5).join(', ')}`);

  // 2. Find a public contact email on each new, unblocked lead's own site.
  const toEnrich = newLeads.filter((l) => !l.region_blocked && l.domain).slice(0, opts.enrichLimit);
  for (const lead of toEnrich) {
    if (opts.shouldStop()) break;
    try {
      const contact = await findContact(lead.domain as string);
      if (contact.status === 'found') summary.contactsFound++;
      lead.contact_email = contact.email;
      lead.contact_status = contact.status;
      if (opts.dryRun) continue;
      await db.from('calldesk_outreach_leads').update({
        contact_email: contact.email, contact_status: contact.status, contact_source_url: contact.sourceUrl, enriched_at: now,
      }).eq('id', lead.id);
    } catch (error) {
      summary.errors.push(`enrich ${lead.company_name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 3. Research: read each qualified contact's own site, retire low-fit ones.
  const researchOn = process.env.OUTREACH_RESEARCH !== '0'; // on by default for this pipeline
  if (researchOn && opts.researchLimit > 0) {
    const { data: toResearch } = await db.from('calldesk_outreach_leads').select('*')
      .eq('product', product).eq('status', 'new').eq('contact_status', 'found').eq('region_blocked', false)
      .is('researched_at', null).not('domain', 'is', null).limit(opts.researchLimit);
    for (const lead of (toResearch ?? []) as LeadRow[]) {
      if (opts.shouldStop()) break;
      try {
        const dossier = researchContact({ name: lead.company_name, domain: lead.domain as string, description: lead.description }, app);
        summary.researched++;
        if (dossier.fit === 'low') summary.lowFit++;
        if (opts.dryRun) continue;
        await db.from('calldesk_outreach_leads').update({
          research: dossier, researched_at: new Date().toISOString(), fit: dossier.fit,
          ...(dossier.fit === 'low' ? { status: 'dead', signal_detail: `Low fit: ${dossier.fit_reason}`.slice(0, 300) } : {}),
        }).eq('id', lead.id);
      } catch (error) {
        summary.errors.push(`research ${lead.company_name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // 4. Draft. Never let unreviewed drafts pile up (shared limit across all products).
  if (opts.dryRun || opts.draftLimit <= 0) return summary;
  const MAX_PENDING = Number(process.env.OUTREACH_MAX_PENDING_DRAFTS || 40);
  const { count: pending } = await db.from('calldesk_outreach_messages').select('id', { count: 'exact', head: true }).eq('status', 'draft');
  const draftLimit = Math.min(opts.draftLimit, Math.max(0, MAX_PENDING - (pending ?? 0)));
  if (draftLimit <= 0) return summary;

  let query = db.from('calldesk_outreach_leads').select('*').eq('product', product)
    .eq('status', 'new').eq('contact_status', 'found').eq('region_blocked', false);
  if (researchOn) query = query.not('researched_at', 'is', null).in('fit', ['high', 'medium', 'unclear']);
  const { data: draftable } = await query.limit(50);

  const { data: msgs } = await db.from('calldesk_outreach_messages').select('lead_id,to_email').eq('product', product).neq('status', 'rejected');
  const drafted = new Set((msgs ?? []).map((m) => m.lead_id as string));
  const emailed = new Set((msgs ?? []).map((m) => String(m.to_email).toLowerCase()));
  const { data: sup } = await db.from('calldesk_outreach_suppressions').select('email');
  const suppressed = new Set((sup ?? []).map((s) => String(s.email).toLowerCase()));

  let made = 0;
  for (const lead of (draftable ?? []) as LeadRow[]) {
    if (made >= draftLimit || opts.shouldStop()) break;
    const email = (lead.contact_email ?? '').toLowerCase();
    if (!email || drafted.has(lead.id) || emailed.has(email) || suppressed.has(email)) continue;
    try {
      const draft = draftPitchEmail({ contactName: lead.company_name, domain: lead.domain, location: lead.location, description: lead.description, dossier: lead.research }, app);
      const { error } = await db.from('calldesk_outreach_messages').insert({
        lead_id: lead.id, to_email: email, subject: draft.subject, body_text: draft.body, status: 'draft',
        product, sources: lead.research?.sources ?? [],
      });
      if (error) throw new Error(error.message);
      await db.from('calldesk_outreach_leads').update({ status: 'report_generated', updated_at: new Date().toISOString() }).eq('id', lead.id);
      emailed.add(email);
      made++;
      summary.draftsCreated++;
    } catch (error) {
      summary.errors.push(`draft ${lead.company_name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return summary;
}
