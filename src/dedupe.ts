// Dedup so a daily run never re-adds a contact already known for this app.
// Matching by domain is enough here (unlike calldesktech's agency directory,
// there's no external "source_key" identity to match on first).
const CORP_SUFFIX = /\b(inc|llc|llp|ltd|gmbh|corp|corporation|co|company|pty|plc)\b\.?/g;

export function compactName(name: string): string {
  return name.toLowerCase().replace(/[™®©]/g, '').replace(CORP_SUFFIX, '').replace(/[^a-z0-9]/g, '');
}

export interface LeadKeyRow {
  id: string;
  company_name: string;
  domain?: string | null;
}

export class LeadIndex<T extends LeadKeyRow> {
  private byName = new Map<string, T>();
  private byDomain = new Map<string, T>();

  constructor(rows: T[]) {
    for (const row of rows) this.add(row);
  }

  add(row: T) {
    const n = compactName(row.company_name);
    if (n && !this.byName.has(n)) this.byName.set(n, row);
    if (row.domain) this.byDomain.set(row.domain.toLowerCase(), row);
  }

  find(input: { name?: string | null; domain?: string | null }): T | undefined {
    if (input.domain && this.byDomain.has(input.domain.toLowerCase())) return this.byDomain.get(input.domain.toLowerCase());
    if (input.name) return this.byName.get(compactName(input.name));
    return undefined;
  }
}
