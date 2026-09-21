// Shared, deliberately polite HTTP helper for discovery: identifies itself,
// times out, and never throws (discovery is best-effort; one dead site must
// not fail the daily run). Copied from calldesktech/src/lib/outreach/discovery/http.ts.
export const DISCOVERY_UA = 'Mozilla/5.0 (compatible; kreativekoala-outreach-research/1.0; +https://kreativekoala.llc)';

export async function politeFetchText(url: string, timeoutMs = 12000): Promise<{ ok: boolean; status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': DISCOVERY_UA, Accept: 'text/html,text/plain' },
      signal: controller.signal,
      redirect: 'follow',
    });
    const text = res.ok ? await res.text() : '';
    return { ok: res.ok, status: res.status, text: text.slice(0, 1_500_000) };
  } catch {
    return { ok: false, status: 0, text: '' };
  } finally {
    clearTimeout(timer);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
