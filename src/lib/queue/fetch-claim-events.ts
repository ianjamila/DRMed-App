import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { eventsByTest, type ClaimEvent } from "./claim-remarks";

// queue_claim_remarks (0160) and result_amendment_remarks (0176) each take at
// most 200 ids per call.
const CHUNK = 200;

/**
 * A test's history for the Remarks lists, keyed by test id: claims (claimed /
 * unclaimed / reassigned, 0160) and — unless `includeEdits` is false — edits
 * made after it was finished ("Updated … by … — reason", 0176). MUST be called
 * with the signed-in staff client: both functions gate on the caller's JWT
 * (has_role; staff_can_read_finished_result for edits, so reception and
 * out-of-section lab staff get no edit rows) — under the service-role client
 * they return nothing. A failed read degrades to "no remarks", never to a
 * broken page; the history is a convenience, not a record anyone acts on.
 */
export async function fetchClaimEvents(
  supabase: SupabaseClient<Database>,
  testRequestIds: readonly string[],
  { includeEdits = true }: { includeEdits?: boolean } = {},
): Promise<Map<string, ClaimEvent[]>> {
  const ids = Array.from(new Set(testRequestIds));
  const rows: ClaimEvent[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const [claims, edits] = await Promise.all([
      supabase.rpc("queue_claim_remarks", { p_test_request_ids: slice }),
      includeEdits
        ? supabase.rpc("result_amendment_remarks", { p_test_request_ids: slice })
        : Promise.resolve({ data: null }),
    ]);
    if (claims.data) rows.push(...claims.data);
    if (edits.data) rows.push(...edits.data);
  }
  return eventsByTest(rows);
}
