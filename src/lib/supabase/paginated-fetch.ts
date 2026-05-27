/**
 * Paginated wrapper for Supabase `select()` calls. PostgREST silently caps
 * results at `MAX_ROWS` (default 1000); use this when an aggregation query
 * may exceed that — finance statement reports over 28K+ posted journal lines
 * after 12.B history import.
 *
 * Pass a builder that takes (from, to) and returns the awaited query result.
 * The helper loops `.range()` calls until a partial page is returned.
 */
export async function paginatedFetch<T>(
  buildPage: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 1000,
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  // Hard ceiling so a runaway query can't go forever.
  const MAX_PAGES = 200; // = up to 200K rows at pageSize 1000
  for (let i = 0; i < MAX_PAGES; i++) {
    const to = from + pageSize - 1;
    const { data, error } = await buildPage(from, to);
    if (error) throw new Error(`paginatedFetch: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}
