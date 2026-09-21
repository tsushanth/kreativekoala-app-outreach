import { cliComplete, extractJson } from './llm';
import { hostOf } from './findDomain';
import { politeFetchText } from './http';
import type { AppConfig } from './apps';

// Finds press/reviewer/community contacts for one app: tech/category blogs,
// YouTubers who review this kind of app, niche newsletters, subreddit/community
// curators. The model only proposes candidates; nothing is trusted until the
// candidate's own site is fetched and actually looks like media/a creator/a
// community, not an app-store listing or a competitor's own site.

export interface SearchCandidate {
  name: string;
  domain: string;
  location: string | null;
  blurb: string | null;
}

const SKIP_HOSTS = [
  'play.google.com', 'apps.apple.com', 'apple.com', 'google.com', 'reddit.com', 'youtube.com', 'facebook.com',
  'twitter.com', 'x.com', 'instagram.com', 'linkedin.com', 'wikipedia.org', 'amazon.com', 'microsoft.com',
];

const PROMPT = (query: string, app: AppConfig) => `Search the web for: ${query}

I'm looking for press/media outlets, independent bloggers, YouTubers, or newsletter curators who write about ${app.category} apps and might want to review or mention a new Android app called ${app.name} (${app.oneLiner}). I am NOT looking for the app stores themselves, competing apps, or big generic tech news sites with no reviewer contact.

Return ONLY a JSON array (at most 10 items) of objects with keys: name (the outlet/creator/newsletter name), website (their own homepage or channel/about page URL, taken from the search results), location (if shown, else null), blurb (one factual sentence about what they cover, from their own site). Only include ones you actually saw in the search results. Use at most 4 web searches, then answer immediately. No commentary, no markdown fences.`;

async function runQuery(query: string, app: AppConfig): Promise<unknown[]> {
  return extractJson<unknown[]>(cliComplete(PROMPT(query, app), { tools: 'WebSearch', maxTurns: 14, timeoutMs: 300_000 }), 'array') ?? [];
}

const LOOKS_LIKE_MEDIA = /(review|blog|editor|press|contact|subscribe|newsletter|channel|about us|write for us|submission|youtube)/i;

export async function verifyCandidateSite(domain: string): Promise<boolean> {
  const res = await politeFetchText(`https://${domain}`, 12000);
  if (!res.ok || res.text.length < 500) return false;
  return LOOKS_LIKE_MEDIA.test(res.text.slice(0, 200_000));
}

export async function findSearchCandidates(
  app: AppConfig,
  perDay: number,
  shouldStop: () => boolean = () => false,
): Promise<{ candidates: SearchCandidate[]; errors: string[]; raw: number; rejected: string[] }> {
  const errors: string[] = [];
  let raw = 0;
  const byDomain = new Map<string, SearchCandidate>();
  const dayNumber = Math.floor(Date.now() / 86_400_000);
  const queries = Array.from({ length: perDay }, (_, i) => app.targeting.queries[(dayNumber + i) % app.targeting.queries.length]);

  for (const query of queries) {
    if (shouldStop()) break;
    try {
      const found = await runQuery(query, app);
      raw += found.length;
      for (const entry of found) {
        const item = entry as { name?: unknown; website?: unknown; location?: unknown; blurb?: unknown };
        if (typeof item.name !== 'string' || typeof item.website !== 'string') continue;
        const domain = hostOf(item.website);
        if (!domain || SKIP_HOSTS.some((h) => domain === h || domain.endsWith(`.${h}`))) continue;
        if (byDomain.has(domain)) continue;
        byDomain.set(domain, {
          name: item.name.trim().slice(0, 120),
          domain,
          location: typeof item.location === 'string' ? item.location.trim().slice(0, 120) : null,
          blurb: typeof item.blurb === 'string' ? item.blurb.trim().slice(0, 400) : null,
        });
      }
    } catch (error) {
      errors.push(`search "${query}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const verified: SearchCandidate[] = [];
  const rejected: string[] = [];
  for (const candidate of byDomain.values()) {
    if (shouldStop()) break;
    if (await verifyCandidateSite(candidate.domain)) verified.push(candidate);
    else rejected.push(candidate.domain);
  }
  return { candidates: verified, errors, raw, rejected };
}
