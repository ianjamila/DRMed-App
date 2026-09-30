import { patientSearchTokens } from "@/lib/patients/search";

/**
 * Server-side free-text search for the two `test_requests` worklists — the lab
 * queue (/staff/queue) and the results archive (/staff/results).
 *
 * Migration 0194 exposes each live test row's searchable text (patient name,
 * DRM-ID, visit #, test code/name, report group, and the other members of its
 * chemistry panel) as the PostgREST computed relationship `lab_search`. A page
 * that is searching selects `lab_search!inner ( )` and chains one ilike per
 * word here, onto the query it already pages with count: "exact" + .range() —
 * so the pager's total and every page are the searched set, and every other
 * gate (tab, section, money, deleted rows) still lives in that one query.
 *
 * Words come from `patientSearchTokens` (whitespace + commas), so matching is
 * AND across words, any order, case-insensitive — what the post-fetch
 * `matchesAllTokens` filter did, minus the page limit.
 */

/** The embedded column the filters target. */
export const LAB_SEARCH_TEXT = "lab_search.search_text";

/**
 * One `%word%` ILIKE pattern per word; `[]` for a blank search. Escapes `\ % _`
 * and PostgREST's `*` wildcard alias the way src/lib/visits/archive-search.ts
 * does, so a typed `%` or `_` is matched literally.
 */
export function labSearchPatterns(query: string | null | undefined): string[] {
  return patientSearchTokens(query).map((token) => `%${token.replace(/[\\%_*]/g, "\\$&")}%`);
}

/** Chain the word filters. The caller must have selected `lab_search!inner ( )`. */
export function applyLabSearch<T extends { ilike: (column: string, pattern: string) => T }>(
  query: T,
  patterns: readonly string[],
): T {
  for (const pattern of patterns) query = query.ilike(LAB_SEARCH_TEXT, pattern);
  return query;
}
