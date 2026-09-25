// OpenRouter API client. Drop-in replacement for the old CLI-based cliComplete.
// Reads OPENROUTER_API_KEY from env. Falls back to the old CLI behaviour if the
// key is missing and CLAUDE_BIN is set, so the harness degrades gracefully.

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = process.env.OUTREACH_CLI_MODEL || 'anthropic/claude-3.5-sonnet';

export interface ApiCompleteOpts {
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export async function apiComplete(prompt: string, opts: ApiCompleteOpts = {}): Promise<string> {
  // Graceful fallback to CLI if no API key is configured
  if (!OPENROUTER_API_KEY) {
    return cliCompleteFallback(prompt, opts);
  }

  const model = opts.model || DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? 4096;
  const timeoutMs = opts.timeoutMs ?? 240_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://kreativekoala.llc',
        'X-Title': 'Kreative Koala Outreach Harness',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenRouter HTTP ${res.status}: ${body.slice(0, 500)}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };

    if (data.error?.message) {
      throw new Error(`OpenRouter error: ${data.error.message}`);
    }

    const content = data.choices?.[0]?.message?.content ?? '';
    return content.trim();
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`OpenRouter request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Fallback: the original CLI-based completion. Kept for local testing or if the
// API key is temporarily missing.
function cliCompleteFallback(prompt: string, opts: ApiCompleteOpts = {}): string {
  const { spawnSync } = require('child_process');
  const args = ['-p', '--output-format', 'text', '--model', DEFAULT_MODEL];
  args.push('--allowedTools', 'WebSearch');

  const result = spawnSync(process.env.CLAUDE_BIN || 'claude', args, {
    input: prompt,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 240_000,
    maxBuffer: 8 * 1024 * 1024,
    env: process.env,
  });

  if (result.error) throw new Error(`claude CLI failed to run: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`claude CLI exited ${result.status}: ${(result.stderr || result.stdout || '').slice(0, 300)}`);
  const out = (result.stdout || '').trim();
  if (/^Not logged in/i.test(out)) throw new Error('claude CLI is not logged in for this session');
  return out;
}

export function extractJson<T = unknown>(text: string, kind: 'array' | 'object'): T | null {
  const open = kind === 'array' ? '[' : '{';
  const close = kind === 'array' ? ']' : '}';
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
