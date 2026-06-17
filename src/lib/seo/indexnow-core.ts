// Pure IndexNow helpers — no `server-only` so vitest can import them.
// Keep all fetch / env-reading / reporting in the server wrapper indexnow.ts.
import type { Json } from "@/types/database";

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

export interface IndexNowEnv {
  VERCEL_ENV?: string;
  INDEXNOW_KEY?: string;
}

/**
 * The configured IndexNow key, trimmed of stray whitespace, or null when
 * unset/blank. Both the key-file route AND the submission payload MUST read
 * the key through this so they can never disagree: if the payload sent an
 * untrimmed value (e.g. an env var with a trailing newline) while the file
 * serves the trimmed value, IndexNow rejects the submission — the key in the
 * request would not match the key in the file.
 */
export function indexNowKey(env: IndexNowEnv): string | null {
  const key = env.INDEXNOW_KEY?.trim();
  return key ? key : null;
}

/**
 * Submissions only fire in production with a configured key. Preview/local
 * no-op so we never ping real engines with non-production URLs.
 */
export function indexNowEnabled(env: IndexNowEnv): boolean {
  return env.VERCEL_ENV === "production" && indexNowKey(env) !== null;
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

const PING_SAMPLE_CAP = 20;

/** Shape the audit_log.metadata for one IndexNow ping. Pure. */
export function buildPingAuditMetadata(
  result: { ok: boolean; submitted: number },
  input: { trigger: string; payloadUrls: string[] },
): Json {
  return {
    trigger: input.trigger,
    ok: result.ok,
    submitted: result.submitted,
    urlCount: input.payloadUrls.length,
    sampleUrls: input.payloadUrls.slice(0, PING_SAMPLE_CAP),
  };
}

export interface PingAuditDisplay {
  trigger: string;
  ok: boolean;
  urlCount: number;
}

/** Read an IndexNow ping audit row's metadata for display. Defensive: JSON of unknown shape. */
export function readPingAuditMetadata(meta: unknown): PingAuditDisplay {
  // audit_log.metadata is Json; narrow defensively (it's display-only).
  const m = (meta && typeof meta === "object" ? meta : {}) as Record<string, unknown>;
  return {
    trigger: typeof m.trigger === "string" ? m.trigger : "unknown",
    ok: m.ok === true,
    urlCount: typeof m.urlCount === "number" ? m.urlCount : 0,
  };
}
