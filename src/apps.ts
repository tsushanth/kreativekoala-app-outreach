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
  // 'android' (default) = a Google Play app; 'web' = a website/web app only (no store app).
  platform?: 'android' | 'web';
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

// How to describe the product in prompts. Every prompt used to hard-code
// "Android app", which made web-only products (e.g. SimplyApply) get pitched
// as Android apps.
export function platformNoun(app: AppConfig): string {
  return app.platform === 'web' ? 'web app' : 'Android app';
}
export function platformFact(app: AppConfig): string {
  return app.platform === 'web'
    ? 'Platform: web app used in the browser at the link below. There is NO Android, iOS or mobile app; never say or imply one exists.'
    : 'Platform: Android app (Google Play).';
}
