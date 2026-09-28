/**
 * The results archive's "Updated" filter (?updated=7d|mine) — narrows the
 * archive to tests whose result was corrected recently, or by the signed-in
 * staff member. Pure — unit-tested in `updated-filter.test.ts`. Applied IN
 * the query in `results/page.tsx`, never post-fetch (CLAUDE.md: a filter
 * applied after the fetch breaks `count: "exact"` + `.range()` paging).
 */

export type UpdatedFilter = "7d" | "mine";

export function parseUpdatedFilter(v: string | string[] | undefined): UpdatedFilter | null {
  const s = Array.isArray(v) ? v[0] : v;
  return s === "7d" || s === "mine" ? s : null;
}

/** Rolling 7×24h on a timestamptz — timezone-independent (CLAUDE.md "rolling window"). */
export function updatedSinceIso(nowMs: number = Date.now()): string {
  return new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString();
}

export const UPDATED_FILTER_LABEL: Record<UpdatedFilter, string> = {
  "7d": "Updated · last 7 days",
  mine: "Updated by me",
};
