import { cliComplete, extractJson } from './llm';
import { hostOf } from './findDomain';
import { platformNoun, type AppConfig } from './apps';

// Research stage: a restricted Claude agent reads a press/creator contact's
// own site and writes a short dossier. The dossier — and any hook drawn from
// it — is only trusted if it cites pages on the contact's own domain.

export type Fit = 'high' | 'medium' | 'low' | 'unclear';

export interface Dossier {
  summary: string;
  covers: string[];
  fit: Fit;
  fit_reason: string;
  hook: string | null;
  sources: string[];
}

export interface ResearchInput {
  name: string;
  domain: string;
  description?: string | null;
}

const PROMPT = (i: ResearchInput, app: AppConfig) => `You are researching whether a media outlet, blogger, YouTuber or newsletter would be a good fit to tell their audience about a new ${platformNoun(app)}.

App: ${app.name} — ${app.oneLiner}
Contact: ${i.name}
Website: https://${i.domain}
${i.description ? `Listing blurb: ${i.description}\n` : ''}
Fetch the homepage and at most 3 other pages on that same site (about, contact, recent posts/videos). Use ONLY what you actually read on those pages. Do not guess or fill gaps from memory.

Return ONLY a JSON object with these keys:
- summary: 1-2 factual sentences on what this outlet/creator covers
- covers: array of up to 6 short topics/categories they actually cover
- fit: "high" if they clearly cover this app's category (${app.category}) and review/mention apps; "medium" if adjacent (general tech/productivity) and plausible; "low" if unrelated or no sign they cover apps/reviews at all; "unclear" if the site could not be read
- fit_reason: one sentence
- hook: ONE specific, verifiable qualitative detail from their site worth mentioning in an email (a recent post/video topic, a stated focus, a submission policy), or null. Do NOT use statistics, follower/subscriber counts, or traffic numbers as the hook.
- sources: the exact URLs you fetched

No commentary, no markdown fences.`;

const FITS: Fit[] = ['high', 'medium', 'low', 'unclear'];
const strArr = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim().slice(0, 200)).filter(Boolean).slice(0, max) : [];

export function normalizeDossier(raw: unknown, domain: string): Dossier {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const own = (u: string) => {
    const h = hostOf(u);
    return !!h && (h === domain || h.endsWith(`.${domain}`));
  };
  const sources = strArr(o.sources, 6).filter(own);
  const fit = FITS.includes(o.fit as Fit) ? (o.fit as Fit) : 'unclear';
  const trusted = sources.length > 0;
  return {
    summary: typeof o.summary === 'string' ? o.summary.trim().slice(0, 400) : '',
    covers: strArr(o.covers, 6),
    fit: trusted ? fit : 'unclear',
    fit_reason: typeof o.fit_reason === 'string' ? o.fit_reason.trim().slice(0, 300) : '',
    hook: trusted && typeof o.hook === 'string' && o.hook.trim() ? o.hook.trim().slice(0, 240) : null,
    sources,
  };
}

export function researchContact(input: ResearchInput, app: AppConfig): Dossier {
  const text = cliComplete(PROMPT(input, app), { tools: 'WebFetch WebSearch', maxTurns: 12, timeoutMs: 300_000 });
  const parsed = extractJson<unknown>(text, 'object');
  if (!parsed) throw new Error('Research reply was not valid JSON');
  return normalizeDossier(parsed, input.domain);
}
