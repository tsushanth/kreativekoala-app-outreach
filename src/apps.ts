import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface AppConfig {
  key: string;
  name: string;
  storeName?: string;
  url?: string;
  packageId: string;
  playUrl: string;
  category: string;
  oneLiner: string;
  targeting: { queries: string[]; subreddits: string[] };
}

let _apps: AppConfig[] | null = null;

export function loadApps(): AppConfig[] {
  if (!_apps) _apps = JSON.parse(readFileSync(join(__dirname, '..', 'apps.json'), 'utf8'));
  return _apps!;
}

export function productFor(app: AppConfig): string {
  return `kreativekoala:${app.key}`;
}

// The name/link to actually put in an email — some apps' Play Store listing
// name or public URL differs from the internal repo/product key.
export function publicName(app: AppConfig): string {
  return app.storeName ?? app.name;
}
export function publicUrl(app: AppConfig): string {
  return app.url ?? app.playUrl;
}
