import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/** Only counts are needed; never download a year's journal just to count it. */
export async function postedCountsByMonth(client: SupabaseClient<Database>, year: number) {
  const counts = await Promise.all(Array.from({ length: 12 }, async (_, index) => {
    const month = index + 1;
    const start = `${year}-${String(month).padStart(2, "0")}-01`;
    const end = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
    const { count, error } = await client.from("journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("status", "posted")
      .gte("posting_date", start)
      .lt("posting_date", end);
    if (error) throw new Error(error.message);
    return [month, count ?? 0] as const;
  }));
  return new Map(counts);
}
