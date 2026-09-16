import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { fetchAllRows } from "@/lib/reports/paging";

/** These worklists intentionally show every doctor. Their counts, amounts and
 * payout selections all depend on complete entry sets, not just the first
 * PostgREST response. Fail on any chunk error rather than show partial totals.
 */
export async function loadPfWorklists(client: SupabaseClient<Database>) {
  const [open, pending] = await Promise.all([
    fetchAllRows(
      (from, to) => client
        .from("doctor_pf_entries")
        .select(`
          id, pf_php, recognized_at, recognition_basis, physician_id,
          test_request_id, hmo_allocation_id, created_at,
          physicians(id, full_name, is_active, physician_compensation(compensation_arrangement))
        `)
        .is("disbursement_id", null)
        .is("voided_at", null)
        .not("recognized_at", "is", null)
        .order("recognized_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
      Infinity,
    ),
    fetchAllRows(
      (from, to) => client
        .from("doctor_pf_entries")
        .select(`
          id, pf_php, recognition_basis, physician_id, test_request_id, created_at,
          physicians(id, full_name)
        `)
        .eq("recognition_basis", "hmo_at_settlement")
        .is("recognized_at", null)
        .is("voided_at", null)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
      Infinity,
    ),
  ]);
  return { openEntries: open.rows, pendingHmo: pending.rows };
}
