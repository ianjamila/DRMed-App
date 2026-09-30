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
 * "Result indicator") is a different number, never the count.
 */

export type AdCountField = "leads" | "bookings";

const CANDIDATES: Record<AdCountField, readonly string[]> = {
  leads: ["lead", "result", "conversation", "messag"],
  bookings: ["booking", "conversion", "purchase", "appointment"],
};

// Headers that name a ratio, price or label about the count, not the count.
const NOT_A_COUNT = /cost|\bper\b|rate|value|ctr|cpc|cpm|cpl|cpa|roas|%|indicator|type|share|rank|quality/i;

/** The header that holds this field's count, or undefined when the file has none. */
export function findCountColumn(
  headers: readonly string[],
  field: AdCountField,
  taken: readonly (string | undefined)[] = [],
): string | undefined {
  for (const candidate of CANDIDATES[field]) {
    const hit = headers.find(
      (h) => h.toLowerCase().includes(candidate) && !NOT_A_COUNT.test(h) && !taken.includes(h),
    );
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
 * A count cell: blank or unreadable ("--", "n/a", negative) is UNKNOWN (null);
 * an explicit 0 is kept. Google reports fractional conversions ("2.50") — those
 * round to the nearest whole, because the database stores whole leads.
 */
export function parseCountCell(v: string | undefined | null): number | null {
  const s = String(v ?? "").replace(/[,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s));
}
