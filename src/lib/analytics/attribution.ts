// First-party, last-touch-with-UTM ad attribution. Set by src/proxy.ts on any
// public marketing-page request whose URL carries a utm_* param; read back by
// server actions (schedule/contact/register) to tag CAPI custom_data and
// audit metadata with the campaign that drove the conversion. Never set or
// read on /staff or /portal (RA 10173 — no marketing tracking in those
// contexts).
//
// This module is intentionally dependency-free so the proxy (which runs in the
// middleware runtime, where `next/headers` does not exist) can import it
// safely. The cookie READER lives in ./attribution-server.ts.

export const ATTRIBUTION_COOKIE_NAME = "drmed_attribution";
export const ATTRIBUTION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface Attribution {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  landing_path?: string;
  captured_at?: string;
  // Index signature so this is assignable to the audit log's Json metadata type.
  [key: string]: string | undefined;
}

const UTM_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
] as const;

// Pure function — called from the proxy, which runs on every request and
// must stay side-effect-free until the final response is built.
export function attributionFromSearchParams(
  searchParams: URLSearchParams,
  pathname: string,
): Attribution | null {
  const found: Attribution = {};
  let any = false;
  for (const key of UTM_KEYS) {
    const v = searchParams.get(key);
    if (v) {
      found[key] = v.slice(0, 200);
      any = true;
    }
  }
  if (!any) return null;
  return { ...found, landing_path: pathname, captured_at: new Date().toISOString() };
}

// Parses the cookie payload written by the proxy. Split out from the reader so
// it stays unit-testable and runtime-agnostic.
export function parseAttributionCookie(raw: string | undefined): Attribution | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Attribution;
  } catch {
    return null;
  }
}
