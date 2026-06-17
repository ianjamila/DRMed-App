// Pure IndexNow helpers — no `server-only` so vitest can import them.
// Keep all fetch / env-reading / reporting in the server wrapper indexnow.ts.

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

export interface IndexNowEnv {
  VERCEL_ENV?: string;
  INDEXNOW_KEY?: string;
}

/**
 * Submissions only fire in production with a configured key. Preview/local
 * no-op so we never ping real engines with non-production URLs.
 */
export function indexNowEnabled(env: IndexNowEnv): boolean {
  return (
    env.VERCEL_ENV === "production" &&
    typeof env.INDEXNOW_KEY === "string" &&
    env.INDEXNOW_KEY.trim().length > 0
  );
}

function trimBase(base: string): string {
  return base.replace(/\/$/, "");
}

/** The doctor's own page plus the physicians index. */
export function physicianPageUrls(base: string, slug: string): string[] {
  const b = trimBase(base);
  return [`${b}/physicians/${slug}`, `${b}/physicians`];
}

/** The service detail page (code lowercased, matching the sitemap), the
 *  all-services index, and the packages page. */
export function servicePageUrls(base: string, code: string): string[] {
  const b = trimBase(base);
  return [`${b}/all-services/${code.toLowerCase()}`, `${b}/all-services`, `${b}/packages`];
}

export interface IndexNowPayload {
  host: string;
  key: string;
  keyLocation: string;
  urlList: string[];
}

/**
 * Build the POST body: dedupe, keep only http(s) URLs on `host`, cap at the
 * IndexNow per-request limit. Returns null when no usable URL remains.
 */
export function buildIndexNowPayload(input: {
  urls: string[];
  key: string;
  host: string;
  keyLocation: string;
}): IndexNowPayload | null {
  const { urls, key, host, keyLocation } = input;
  const seen = new Set<string>();
  const urlList: string[] = [];
  for (const raw of urls) {
    const u = raw.trim();
    if (!u) continue;
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    if (parsed.host !== host) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    urlList.push(u);
    if (urlList.length >= 10000) break;
  }
  if (urlList.length === 0) return null;
  return { host, key, keyLocation, urlList };
}
