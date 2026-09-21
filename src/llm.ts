import { spawnSync } from 'child_process';

// CLI-only (this harness runs on the Mac mini only, using the logged-in
// `claude` OAuth account — see harness/app-outreach/README.md). No API-key
// fallback, unlike calldesktech's llm.ts, since this repo never runs on Fly.

export function cliComplete(prompt: string, opts: { tools?: string; maxTurns?: number; timeoutMs?: number } = {}): string {
  const args = ['-p', '--output-format', 'text', '--model', process.env.OUTREACH_CLI_MODEL || 'sonnet', '--max-turns', String(opts.maxTurns ?? 3)];
  args.push('--allowedTools', opts.tools ?? 'WebSearch');

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
