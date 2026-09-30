/**
 * The ONE place that decides which column of an ad export means "leads" and
 * which means "bookings" (and how a count cell is read). The Ad Performance
 * screen used to do this fuzzy matching in the browser (`mapRow`); the server
 * parser (`ad-spend-import.ts`) now uses this module, so what the database
 * stores is what the screen used to show.
 *
 * Header matching is a substring match, in priority order, like the old screen:
 *   leads    : lead | result | conversation | messag
 *   bookings : booking | conversion | purchase | appointment
 * "result" is a LEADS-only word (Meta's single "Results" column), so one column
 * never feeds both fields; a column already taken by leads is skipped for
 * bookings. Two guards the old screen lacked: a header that is a COST, RATE,
 * VALUE or RANK ("Cost per lead", "Conversion rate", "Conversion value",
 * "Result indicator") is a different number, never the count; so is a NAME,
 * ACTION, SOURCE, FORM or CATEGORY label ("Lead form name", "Conversion
 * action", "Conversion source"). A header saying "... form conversions/leads/
 * submissions/results" is still a count and is kept.
 *
 * Google's own short headers are bookings aliases too: "Conv." (and "All
 * conv."). "Conversions" / "Conv." are preferred over any "All ..." column
 * (Google's broader all-conversions figure) when both exist.
 */

export type AdCountField = "leads" | "bookings";

const CANDIDATES: Record<AdCountField, readonly RegExp[]> = {
  leads: [/lead/i, /result/i, /conversation/i, /messag/i],
  bookings: [/booking/i, /conversion/i, /purchase/i, /appointment/i, /^(?:all\s+)?conv\.?$/i],
};

// Headers that name a ratio, price or label about the count, not the count.
const NOT_A_COUNT =
  /cost|\bper\b|rate|value|ctr|cpc|cpm|cpl|cpa|roas|%|indicator|type|share|rank|quality|name|action|source|category|\bforms?\b(?!\s+(?:conversions?|leads?|submissions?|results?)\b)/i;

/** The header that holds this field's count, or undefined when the file has none. */
export function findCountColumn(
  headers: readonly string[],
  field: AdCountField,
  taken: readonly (string | undefined)[] = [],
): string | undefined {
  // "All ..." columns (Google's broader all-conversions figure) come last.
  const ordered = [...headers.filter((h) => !/^all\b/i.test(h.trim())), ...headers.filter((h) => /^all\b/i.test(h.trim()))];
  for (const candidate of CANDIDATES[field]) {
    const hit = ordered.find((h) => candidate.test(h.trim()) && !NOT_A_COUNT.test(h) && !taken.includes(h));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Both count columns for a header row (leads first, so it wins a contested column). */
export function mapCountColumns(headers: readonly string[]): { leads?: string; bookings?: string } {
  const leads = findCountColumn(headers, "leads");
  const bookings = findCountColumn(headers, "bookings", [leads]);
  return { leads, bookings };
}

/**
 * A count cell, EXACT: blank or unreadable ("--", "n/a", negative) is UNKNOWN
 * (null); an explicit 0 is kept. Google reports fractional conversions
 * ("2.50") — those stay fractional here so a duplicate-row sum is exact; the
 * parser rounds ONCE per stored row (see roundCount).
 */
export function parseCountCellExact(v: string | undefined | null): number | null {
  const s = String(v ?? "").replace(/[,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

/** Round a (summed) fractional count half-up to a whole number; float noise (1.2000000000000002, 2.4999999999999996) is trimmed first. */
export function roundCount(n: number): number {
  return Math.round(Math.round(n * 1e6) / 1e6);
}

/** A count cell rounded to a whole number (single cell; the parser itself sums first, then rounds once). */
export function parseCountCell(v: string | undefined | null): number | null {
  const n = parseCountCellExact(v);
  return n === null ? null : roundCount(n);
}
