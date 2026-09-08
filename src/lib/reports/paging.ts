/**
 * Paging + chunking for the admin report loaders.
 *
 * PostgREST hard-caps one response at 1000 rows, so any report that can exceed
 * that has to walk the set with `.range()`; and `.in()` lists ride in the GET
 * query string, so lookups are chunked to keep URLs short. Pure — the fetcher
 * is injected, which is what keeps this vitest-testable. Not `server-only`.
 */

/** PostgREST's per-response cap. */
export const PAGE_SIZE = 1000;

/** Ids per `.in()` call. 200 UUIDs ≈ 7.5 KB of query string — well under proxy limits. */
export const IN_CHUNK = 200;

/**
 * Hard ceiling on rows a report export will walk — the same figure as
 * /api/admin/visits.csv. A report that hits it says so in-band (a TRUNCATED
 * row) and in its audit metadata rather than silently stopping.
 */
export const REPORT_EXPORT_MAX_ROWS = 20_000;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new RangeError(`chunk size must be a positive integer, got ${size}`);
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function unique<T>(items: readonly (T | null | undefined)[]): T[] {
  return Array.from(
    new Set(items.filter((v): v is T => v !== null && v !== undefined)),
  );
}

/** One `.range(from, to)` call. A supabase-js builder is itself thenable and satisfies this. */
export type PageFetcher<T> = (
  from: number,
  to: number,
) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/**
 * Walk `fetchPage` until the set ends or `maxRows` is reached. Asks for one
 * row past the ceiling so `truncated` is exact without a count query. The
 * query MUST carry a total order (add an `id` tie-break) or pages can repeat
 * or drop rows. Throws on a DB error — a partial export that reads as
 * complete is worse than a failed one.
 */
export async function fetchAllRows<T>(
  fetchPage: PageFetcher<T>,
  maxRows: number,
): Promise<{ rows: T[]; truncated: boolean }> {
  const want = maxRows + 1;
  const out: T[] = [];
  while (out.length < want) {
    const from = out.length;
    const to = Math.min(from + PAGE_SIZE, want) - 1;
    const { data, error } = await fetchPage(from, to);
    if (error) throw new Error(`report page ${from}–${to}: ${error.message}`);
    const page = data ?? [];
    out.push(...page);
    if (page.length < to - from + 1) break;
  }
  return { rows: out.slice(0, maxRows), truncated: out.length > maxRows };
}
