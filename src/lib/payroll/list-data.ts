import { fetchAllRows, type PageFetcher } from "@/lib/reports/paging";

/** Preserve the existing loaders' error banners while walking beyond PostgREST's
 * 1000-row cap. Callers order by id last. In-memory joins, filters and payroll
 * totals need the complete set BEFORE the displayed table is sorted/paged.
 */
export async function fetchPayrollRows<T>(fetchPage: PageFetcher<T>) {
  try {
    const { rows } = await fetchAllRows(fetchPage, Infinity);
    return { data: rows, error: null };
  } catch (error) {
    return { data: null, error: { message: error instanceof Error ? error.message : "Failed to load payroll rows." } };
  }
}
