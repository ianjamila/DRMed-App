// Single source of truth for the on-domain Google-review link.
// All four review touchpoints (receipt, poster, result email, portal card)
// point at /review?src=<surface>, which 302-redirects to the verified GBP
// review composer (see src/app/review/route.ts). Keeping it on-domain makes
// the link brandable, lets us change the destination in one place, and gives
// per-surface scan counts. This module is intentionally free of `server-only`
// imports so it stays unit-testable.

export const REVIEW_PATH = "/review";

export type ReviewSource = "receipt" | "poster" | "portal" | "email" | "unknown";

const KNOWN_SOURCES: ReadonlySet<string> = new Set([
  "receipt",
  "poster",
  "portal",
  "email",
]);

/** Whitelist an incoming ?src value; anything unexpected becomes "unknown". */
export function reviewLinkSource(raw: string | null | undefined): ReviewSource {
  return raw && KNOWN_SOURCES.has(raw) ? (raw as ReviewSource) : "unknown";
}

/** Relative tracked link, e.g. "/review?src=receipt". */
export function reviewLink(src: Exclude<ReviewSource, "unknown">): string {
  return `${REVIEW_PATH}?src=${src}`;
}

/** Absolute tracked link from an origin (handles a trailing slash). */
export function reviewLinkAbsolute(
  base: string,
  src: Exclude<ReviewSource, "unknown">,
): string {
  return `${base.replace(/\/$/, "")}${reviewLink(src)}`;
}
