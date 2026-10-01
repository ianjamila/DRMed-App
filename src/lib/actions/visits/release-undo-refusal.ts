import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readInChunks } from "@/lib/supabase/in-chunks";
import { reportError } from "@/lib/observability/report-error";

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
 * failed read flags nothing (the caller keeps CHANGED_SINCE_REASON). Every
 * id-list read is chunked (a batch can carry 500 ids) and fails closed.
 */
export async function idsWithMateReleasedOutsideBatch(
  supabase: SupabaseClient,
  refusedIds: readonly string[],
  batchIds: ReadonlySet<string>,
): Promise<Set<string>> {
  const none = new Set<string>();
  const unique = Array.from(new Set(refusedIds));
  if (unique.length === 0) return none;
  try {
    const own = await readInChunks<ReportLink>(unique, (chunk) =>
      supabase.from("result_test_requests").select("result_id, test_request_id").in("test_request_id", chunk),
    );
    if (!own.ok) throw own.error;
    if (own.rows.length === 0) return none;
    const reportOf = new Map(own.rows.map((l) => [l.test_request_id, l.result_id]));

    const members = await readInChunks<ReportLink>([...new Set(reportOf.values())], (chunk) =>
      supabase.from("result_test_requests").select("result_id, test_request_id").in("result_id", chunk),
    );
    if (!members.ok) throw members.error;
    const outside = members.rows.filter((m) => !batchIds.has(m.test_request_id));
    if (outside.length === 0) return none;

    const released = await readInChunks<{ id: string }>(
      outside.map((m) => m.test_request_id),
      (chunk) =>
        supabase.from("test_requests").select("id, visits!inner ( id )")
          .in("id", chunk)
          .eq("status", "released")
          .is("deleted_at", null)
          .is("visits.deleted_at", null),
    );
    if (!released.ok) throw released.error;
    const releasedSet = new Set(released.rows.map((r) => r.id));
    const flagged = new Set(outside.filter((m) => releasedSet.has(m.test_request_id)).map((m) => m.result_id));
    return new Set(unique.filter((id) => flagged.has(reportOf.get(id) ?? "")));
  } catch (error) {
    try {
      await reportError({ scope: "release/undo-refusal-lookup", error, metadata: { ids: unique } });
    } catch {
      // Reporting itself failed — the generic reason stands.
    }
    return none;
  }
}
