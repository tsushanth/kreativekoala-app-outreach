// Regions excluded from cold email: Germany, Austria and Switzerland require
// prior consent even for B2B marketing email. Same rule as calldesktech's
// discovery/score.ts. This is B2B (contacting a publication/creator's
// business contact), so individual-consent rules don't apply, but this one does.
const BLOCKED_REGION_HINTS = ['germany', 'deutschland', 'austria', 'switzerland', 'liechtenstein', 'gmbh'];
const BLOCKED_TLDS = ['.de', '.at', '.ch', '.li'];

export function isBlockedDomain(domain: string | null): boolean {
  const d = (domain || '').toLowerCase();
  return BLOCKED_TLDS.some((t) => d.endsWith(t));
}

export function isRegionBlocked(location: string | null, name = ''): boolean {
  const hay = `${location || ''} ${name}`.toLowerCase();
  return BLOCKED_REGION_HINTS.some((h) => hay.includes(h));
}
