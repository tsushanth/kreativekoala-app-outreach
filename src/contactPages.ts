import { politeFetchText, sleep } from './http';

// Looks for a publicly listed contact email on the agency's OWN website
// (homepage, /contact, /about). No paid enrichment, no guessing addresses.
// Honors robots.txt for the paths it requests. A page with only a form
// yields status 'form_only' so a human can use the form instead.

export interface ContactResult {
  status: 'found' | 'form_only' | 'none';
  email: string | null;
  sourceUrl: string | null;
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const JUNK_LOCALPARTS = ['noreply', 'no-reply', 'donotreply', 'privacy', 'abuse', 'postmaster', 'webmaster', 'unsubscribe', 'legal', 'careers', 'jobs', 'press'];
const JUNK_DOMAINS = ['example.com', 'sentry.io', 'wixpress.com', 'godaddy.com', 'domain.com', 'email.com', 'yourdomain.com'];
const PREFERRED = ['partners', 'partnership', 'hello', 'hi', 'contact', 'info', 'sales', 'team', 'support'];
const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|avif)$/i;

function disallowedPaths(robots: string): string[] {
  const out: string[] = [];
  let applies = false;
  for (const raw of robots.split('\n')) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') applies = value === '*';
    else if (applies && key === 'disallow' && value) out.push(value);
  }
  return out;
}

export function extractEmails(html: string, domain: string): string[] {
  const decoded = html.replace(/&#64;|&commat;|\[at\]|\(at\)/gi, '@');
  const found = new Set<string>();
  for (const m of decoded.match(EMAIL_RE) || []) {
    const email = m.toLowerCase().replace(/^mailto:/, '');
    if (IMAGE_EXT.test(email)) continue;
    const [local, host] = email.split('@');
    if (!host || JUNK_DOMAINS.some((d) => host.endsWith(d))) continue;
    if (JUNK_LOCALPARTS.some((j) => local.startsWith(j))) continue;
    found.add(email);
  }
  // Only accept addresses on the agency's own domain, never a third party's.
  return [...found].filter((e) => e.split('@')[1].replace(/^www\./, '') === domain);
}

export function pickBest(emails: string[]): string | null {
  if (!emails.length) return null;
  for (const p of PREFERRED) {
    const hit = emails.find((e) => e.split('@')[0] === p);
    if (hit) return hit;
  }
  return emails[0];
}

export async function findContact(domain: string): Promise<ContactResult> {
  const base = `https://${domain}`;
  const robots = await politeFetchText(`${base}/robots.txt`, 6000);
  const blocked = robots.ok ? disallowedPaths(robots.text) : [];
  const allowed = (path: string) => !blocked.some((b) => b === '/' || path.startsWith(b));

  let sawForm = false;
  for (const path of ['/contact', '/contact-us', '/about', '/']) {
    if (!allowed(path)) continue;
    const url = `${base}${path}`;
    const res = await politeFetchText(url);
    await sleep(800);
    if (!res.ok) continue;

    const email = pickBest(extractEmails(res.text, domain));
    if (email) return { status: 'found', email, sourceUrl: url };
    if (/<form[\s>]/i.test(res.text)) sawForm = true;
  }
  return { status: sawForm ? 'form_only' : 'none', email: null, sourceUrl: null };
}
