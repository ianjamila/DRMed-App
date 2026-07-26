// Cookie-consent primitives for the public marketing site.
//
// Model: OPT-IN / STRICT. Nothing marketing-related runs until the visitor
// explicitly accepts — no Meta Pixel, no PageView, no UTM attribution cookie,
// no server-side Conversions API event. A visitor who never answers the banner
// is treated exactly like one who declined.
//
// This module is intentionally dependency-free (no next/headers, no document)
// so the proxy (middleware runtime), server actions, client components, and
// unit tests can all share one definition of "has this person consented?".
// The server-side reader lives in ./consent-server.ts.

export const CONSENT_COOKIE_NAME = "drmed_cookie_consent";

// 180 days. Long enough not to nag, short enough that consent is re-confirmed
// within a reasonable window rather than being treated as permanent.
export const CONSENT_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;

// Cookies written by the Meta Pixel itself. Cleared when consent is declined
// or withdrawn — declining has to remove what was already dropped, not just
// stop future writes.
export const META_PIXEL_COOKIE_NAMES = ["_fbp", "_fbc"] as const;

export type ConsentChoice = "granted" | "denied";

export function parseConsentChoice(raw: string | undefined | null): ConsentChoice | null {
  if (raw === "granted" || raw === "denied") return raw;
  return null;
}

// The single gate every marketing tracking surface asks. Anything other than
// an explicit "granted" — absent, malformed, declined — means do not track.
export function hasAdvertisingConsent(raw: string | undefined | null): boolean {
  return parseConsentChoice(raw) === "granted";
}

// Minimal cookie-header parser so client components can read consent from
// `document.cookie` without pulling in a dependency, and so the logic is
// unit-testable. Returns undefined when the cookie isn't present.
export function readCookieFromHeader(
  header: string | undefined | null,
  name: string,
): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}
