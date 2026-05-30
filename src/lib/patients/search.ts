/**
 * Smart, token-based patient search shared by every staff search box.
 *
 * Reception types names in any order, often "last, first" — e.g. "Jamila, Ian"
 * for a patient stored as `first_name = "Ian"`, `last_name = "Jamila"`. Matching
 * the whole query string against any single column never finds that row, so a
 * two-word search returned nothing while the single word "jamila" worked.
 *
 * Fix: split the query into tokens and require EVERY token to match at least one
 * searchable field (AND across tokens, OR across fields). Word order doesn't
 * matter, and the comma — which is also PostgREST's `.or()` delimiter — is
 * consumed by tokenisation, so it can never corrupt the filter again.
 *
 * Pure logic (no `server-only`, no DB) so it's unit-tested and usable from both
 * server queries and client/post-fetch filtering.
 */

/** Fields a free-text token is matched against. */
export const PATIENT_SEARCH_FIELDS = [
  "drm_id",
  "first_name",
  "middle_name",
  "last_name",
  "phone",
  "email",
] as const;

/** Split a free-text query into search tokens (whitespace + commas). */
export function patientSearchTokens(query: string | null | undefined): string[] {
  return (query ?? "").trim().split(/[\s,]+/).filter(Boolean);
}

/** Escape ILIKE/PostgREST wildcards in a single token. Backslash first. */
function escapeLikeToken(token: string): string {
  return token.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Build the PostgREST `.or()` clauses for a patient search — one clause per
 * token. Chain them onto a query builder so they AND together (every token must
 * match some field):
 *
 *   for (const clause of patientSearchOrClauses(term)) q = q.or(clause);
 *
 * Returns `[]` for a blank query, so the caller leaves the query unfiltered.
 */
export function patientSearchOrClauses(
  query: string | null | undefined,
  fields: readonly string[] = PATIENT_SEARCH_FIELDS,
): string[] {
  return patientSearchTokens(query).map((token) => {
    const like = `%${escapeLikeToken(token)}%`;
    return fields.map((f) => `${f}.ilike.${like}`).join(",");
  });
}

/**
 * Token match for post-fetch / client filtering where a DB query isn't
 * available (e.g. results joined across tables in PostgREST). Every token must
 * appear as a case-insensitive substring of the combined haystack. A blank
 * query matches everything (callers typically guard against that anyway).
 */
export function matchesAllTokens(haystack: string, query: string | null | undefined): boolean {
  const hay = haystack.toLowerCase();
  return patientSearchTokens(query).every((t) => hay.includes(t.toLowerCase()));
}
