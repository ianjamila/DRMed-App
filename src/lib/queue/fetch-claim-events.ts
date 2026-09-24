import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { eventsByTest, type ClaimEvent } from "./claim-remarks";

// queue_claim_remarks (0160) takes at most 200 ids per call.
const CHUNK = 200;

/**
 * Claim history (claimed / unclaimed / reassigned) for a set of tests, keyed
 * by test id. MUST be called with the signed-in staff client: the function
 * gates on has_role(), which reads the caller's JWT — under the service-role
 * client it returns nothing. A failed read degrades to "no remarks", never to
 * a broken page; the history is a convenience, not a record anyone acts on.
 */
export async function fetchClaimEvents(
  supabase: SupabaseClient<Database>,
  testRequestIds: readonly string[],
): Promise<Map<string, ClaimEvent[]>> {
  const ids = Array.from(new Set(testRequestIds));
  const rows: ClaimEvent[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data } = await supabase.rpc("queue_claim_remarks", {
      p_test_request_ids: ids.slice(i, i + CHUNK),
    });
    if (data) rows.push(...data);
  }
  return eventsByTest(rows);
}
