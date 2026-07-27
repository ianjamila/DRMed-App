/**
 * Turn what a staffer types into a visit-number box into a query filter.
 *
 * `visits.visit_number` is text. The live sequence issues zero-padded numbers
 * ("0037"), but reception says and writes "37" or "#37" — and the clinical
 * backfill issued legacy numbers of a different shape entirely ("H-1234").
 * So: numeric input matches exactly against both the padded and the raw form,
 * anything else falls back to a contains match.
 *
 * Pure logic (no `server-only`, no DB) so it's unit-tested and usable from
 * both server queries and post-fetch filtering.
 */

export type VisitNumberFilter =
  | { kind: "exact"; values: string[] }
  | { kind: "contains"; pattern: string };

/** Escape ILIKE wildcards in typed input. Backslash first. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Returns `null` for blank input, so the caller leaves the query unfiltered. */
export function visitNumberFilter(
  input: string | null | undefined,
): VisitNumberFilter | null {
  const raw = (input ?? "").trim().replace(/^#+/, "").trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const padded = raw.padStart(4, "0");
    return {
      kind: "exact",
      values: padded === raw ? [padded] : [padded, raw],
    };
  }

  return { kind: "contains", pattern: `%${escapeLike(raw)}%` };
}
