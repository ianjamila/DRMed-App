import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { LEDGER_TOTAL_STATUSES } from "./ledger-status";

/**
 * Journal entries per month of `year`, for the period-close page.
 *
 * Counts posted AND reversed entries (LEDGER_TOTAL_STATUSES): undoing an
 * entry later flips the original to 'reversed' and posts its mirror in the
 * month of the undo. Counting posted alone made a closed month's figure drop
 * by one after the fact while the undo month gained one.
 *
 * Only counts are needed; never download a year's journal just to count it.
 */
export async function entryCountsByMonth(client: SupabaseClient<Database>, year: number) {
  const counts = await Promise.all(Array.from({ length: 12 }, async (_, index) => {
    const month = index + 1;
    const start = `${year}-${String(month).padStart(2, "0")}-01`;
    const end = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
    const { count, error } = await client.from("journal_entries")
      .select("id", { count: "exact", head: true })
      .in("status", LEDGER_TOTAL_STATUSES)
      .gte("posting_date", start)
      .lt("posting_date", end);
    if (error) throw new Error(error.message);
    return [month, count ?? 0] as const;
  }));
  return new Map(counts);
}
