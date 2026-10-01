import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Why a 10-minute release Undo leaves a combined report alone when a member
 * of it was released by another call. undo_visit_release only says
 * "changed_since" for every refused line; this names the common case — the
 * report was completed by a line released earlier, outside this batch — so
 * the operator knows to undo the whole report from its page instead of
 * retrying. Lowercase fragment: it renders after "• <test>: ".
 */
export const RELEASED_SEPARATELY_REASON =
  "part of this report was released separately — undo it from the report page";

interface ReportLink {
  result_id: string;
  test_request_id: string;
}

/**
 * Of `refusedIds` (batch lines the Undo did not restore), the ones whose
 * combined report has a LIVE, RELEASED member this batch did not release
 * (`batchIds` = every line with a test_request.released row in the batch).
 * Wording only — the database already decided; so it never throws, and any
 * failed read flags nothing (the caller keeps CHANGED_SINCE_REASON).
 */
export async function idsWithMateReleasedOutsideBatch(
  supabase: SupabaseClient,
  refusedIds: readonly string[],
  batchIds: ReadonlySet<string>,
): Promise<Set<string>> {
  const none = new Set<string>();
  if (refusedIds.length === 0) return none;
  try {
    const { data: own, error: ownErr } = await supabase
      .from("result_test_requests")
      .select("result_id, test_request_id")
      .in("test_request_id", [...refusedIds]);
    const ownLinks = (own ?? []) as ReportLink[];
    if (ownErr || ownLinks.length === 0) return none;
    const reportOf = new Map(ownLinks.map((l) => [l.test_request_id, l.result_id]));

    const { data: members, error: memErr } = await supabase
      .from("result_test_requests")
      .select("result_id, test_request_id")
      .in("result_id", [...new Set(reportOf.values())]);
    if (memErr || !members) return none;
    const outside = (members as ReportLink[]).filter((m) => !batchIds.has(m.test_request_id));
    if (outside.length === 0) return none;

    const { data: released, error: relErr } = await supabase
      .from("test_requests")
      .select("id, visits!inner ( id )")
      .in("id", outside.map((m) => m.test_request_id))
      .eq("status", "released")
      .is("deleted_at", null)
      .is("visits.deleted_at", null);
    if (relErr || !released) return none;
    const releasedSet = new Set((released as Array<{ id: string }>).map((r) => r.id));
    const flagged = new Set(outside.filter((m) => releasedSet.has(m.test_request_id)).map((m) => m.result_id));
    return new Set(refusedIds.filter((id) => flagged.has(reportOf.get(id) ?? "")));
  } catch {
    return none;
  }
}
