import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { daysInMonth, isISODate, isoDateParts, shiftISODate } from "@/lib/dates/manila";
import { pageCount, parsePage, parsePageSize, parseSort, rangeFor, type SortSpec } from "@/lib/ui/table-params";

export const HISTORY_SORTABLE = ["batch_number", "posted_date", "physician", "method", "total_php"] as const;
export type HistorySort = (typeof HISTORY_SORTABLE)[number];
export const HISTORY_DEFAULT_SORT: SortSpec<HistorySort> = { key: "posted_date", dir: "desc" };
const ORDER_COLUMNS: Record<HistorySort, string> = {
  batch_number: "batch_number", posted_date: "posted_date",
  physician: "physicians(full_name)", method: "method", total_php: "total_php",
};

export function parsePfHistoryParams(sp: Record<string, string | undefined>, today: string) {
  const validDate = (value: string | undefined): value is string => {
    if (!isISODate(value)) return false;
    const { year, month, day } = isoDateParts(value);
    return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
  };
  let start = validDate(sp.start) ? sp.start : shiftISODate(today, -90);
  // No upper bound on first load, preserving the original >= 90-day query.
  let end = validDate(sp.end) ? sp.end : null;
  if (end && start > end) [start, end] = [end, start];
  return {
    start, end,
    sort: parseSort(sp.sort, sp.dir, HISTORY_SORTABLE, HISTORY_DEFAULT_SORT),
    size: parsePageSize(sp.size), page: parsePage(sp.page),
  };
}

export type PfHistoryState = ReturnType<typeof parsePfHistoryParams> & { total: number };

/** Only one display page crosses the server/client boundary, even for decades
 * of history. Count and rows use identical DATE filters; id is always ascending.
 */
export async function loadPfHistory(client: SupabaseClient<Database>, params: ReturnType<typeof parsePfHistoryParams>) {
  const query = (head = false) => {
    let q = client.from("doctor_pf_disbursements")
      .select("id, batch_number, posted_date, method, total_php, voided_at, physicians!inner(id, full_name)", { count: "exact", head })
      .gte("posted_date", params.start);
    if (params.end) q = q.lte("posted_date", params.end);
    return q;
  };
  const { count, error: countError } = await query(true);
  if (countError) throw new Error(countError.message);
  const total = count ?? 0;
  const page = Math.min(params.page, pageCount(total, params.size));
  const [from, to] = rangeFor(page, params.size);
  const { data, error } = await query()
    .order(ORDER_COLUMNS[params.sort.key], { ascending: params.sort.dir === "asc", nullsFirst: false })
    .order("id", { ascending: true })
    .range(from, to);
  if (error) throw new Error(error.message);
  return { rows: data ?? [], state: { ...params, total, page } };
}
