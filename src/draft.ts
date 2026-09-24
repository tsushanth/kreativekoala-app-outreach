import { cliComplete, extractJson } from './llm';
import type { AppConfig } from './apps';
import { publicName, publicUrl, platformNoun, platformFact } from './apps';
import type { Dossier } from './research';

// Drafts a short first-touch pitch email to a press/reviewer/community contact
// about one app. Facts the model may state come only from the app's own
// apps.json entry (name, one-liner, link) plus, if present, the ONE verified
// hook from research.ts — never invented user counts, ratings, or press quotes.

export interface DraftInput {
  contactName: string;
  domain?: string | null;
  location?: string | null;
  description?: string | null;
  dossier?: Pick<Dossier, 'summary' | 'covers' | 'hook'> | null;
}

export interface Draft {
  subject: string;
  body: string;
}

const systemPrompt = (app: AppConfig) => `You write short, specific, honest first-touch pitch emails from the founders of Kreative Koala LLC to press, bloggers, YouTubers, or newsletter curators, about one of the company's products (a ${platformNoun(app)}).

Rules:
- State ONLY the app facts given (name, one-liner, platform, link). Describe the product only as the platform fact says (never call a web app an Android/iOS/mobile app). Never invent user counts, ratings, revenue, awards, or press coverage.
- Personalize with one concrete detail about the recipient's own site/channel/coverage, without flattery.
- One clear, low-friction ask: review it, mention it, or just try it — never demand coverage.
- Offer to answer questions or provide more info (screenshots, a build) if useful; do not promise a specific promo code or payment.
- No hype words, no emojis, no exclamation marks.
- Write in the first person plural ("we", "us", "our"). Never use "I", "me" or "my", and never introduce yourselves by name or title.
- Do NOT write a sign-off or signature; one is added automatically.
- Any sentence that asks something must end with a question mark.`;

export const SIGNATURE = 'Sushanth & Deepika\nKreative Koala LLC';

export function tidyBody(body: string): string {
  const lines = body.trim().split('\n');
  const signoff = /^(best|regards|kind regards|thanks|thank you|cheers|sincerely|warmly|best regards)[,.]?$|^sushanth\b.*$|^deepika\b.*$|^(co-?)?founders?\b.*$|^kreative koala\s*$|^--+$/i;
  while (lines.length && (lines[lines.length - 1].trim() === '' || signoff.test(lines[lines.length - 1].trim()))) lines.pop();
  let b = lines.join('\n').trim();
  b = b.replace(/((?:Would|Could|Can|Are|Do|Is|Might)\b[^.?!\n]*)\.(\s*)$/gm, '$1?$2');
  return `${b}\n\n${SIGNATURE}`;
}

export function draftPitchEmail(input: DraftInput, app: AppConfig): Draft {
  const userPrompt = [
    `Recipient: ${input.contactName}${input.domain ? ` (${input.domain})` : ''}`,
    input.location ? `Location: ${input.location}` : '',
    input.description ? `Their own description of what they cover:\n"""\n${input.description}\n"""` : '',
    input.dossier
      ? `Verified facts from their own site (mention at most ONE, exactly as stated, no embellishment):\n- ${input.dossier.summary}${input.dossier.hook ? `\n- Specific detail: ${input.dossier.hook}` : ''}${input.dossier.covers.length ? `\n- They cover: ${input.dossier.covers.join(', ')}` : ''}`
      : '',
    '',
    `App facts you may use (and nothing else):`,
    `- ${publicName(app)}: ${app.oneLiner}`,
    `- ${platformFact(app)}`,
    `- Category: ${app.category}`,
    `- Link: ${publicUrl(app)}`,
  ]
    .filter((l) => l !== '')
    .join('\n');

  const text = cliComplete(
    `${systemPrompt(app)}\n\n${userPrompt}\n\nReply with ONLY a JSON object {"subject": string, "body": string}. Body: plain text, 90-140 words, 2-3 short paragraphs, no greeting name guess if unsure (start with "Hi there," instead). No sign-off, no links beyond the app link, no footer. No markdown fences, no commentary.`,
    { maxTurns: 2 },
  );
  const parsed = extractJson<Draft>(text, 'object');
  if (!parsed || typeof parsed.subject !== 'string' || typeof parsed.body !== 'string') throw new Error('Draft reply was not valid JSON');
  return { subject: parsed.subject.trim(), body: tidyBody(parsed.body) };
}
